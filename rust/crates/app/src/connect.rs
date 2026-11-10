//! The Connect dialog (desktop): saved database connections, and their tables as Readers.
//!
//! Connections are saved by name (docs/decisions/0012-database-connections.md): the details in
//! `connections.json`, the password in the OS keychain. A Reader keeps the connection's name,
//! the schema and the table, never the password. Listing tables runs on a thread of its own,
//! so a slow server never holds up the window.

use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};

use geomarmot_connections::{Connection, Store};
use geomarmot_io::postgres::{TableInfo, list_tables};
use geomarmot_sql::pg::PgServer;
use serde_json::{Value, json};

use super::App;
use crate::canvas::colour;
use crate::worker::Job;

#[path = "connect_form.rs"]
mod form;
use form::Form;

type Listing = Result<Vec<TableInfo>, String>;

enum Purpose {
    Browse(String),
    Test,
}

#[derive(Default)]
pub struct ConnectDialog {
    list: Vec<Connection>,
    browsing: Option<String>,
    tables: Option<Listing>,
    filter: String,
    form: Option<Form>,
    /// The last outcome: (good, text).
    message: Option<(bool, String)>,
    pending: Option<(Purpose, Receiver<Listing>)>,
}

/// List the tables of `server` on a thread; the window repaints when they arrive.
fn fetch(server: PgServer, password: String, ctx: &egui::Context) -> Receiver<Listing> {
    let (tx, rx) = channel();
    let ctx = ctx.clone();
    std::thread::spawn(move || {
        let _ = tx.send(list_tables(&server, &password));
        ctx.request_repaint();
    });
    rx
}

impl App {
    /// The Reader's job for a database table, from the saved connection its params name.
    pub(super) fn open_db_job(&self, params: &Value, label: String) -> Result<Job, String> {
        let store = self
            .connections
            .as_ref()
            .ok_or("Database connections are not available.")?;
        let text = |k: &str| params[k].as_str().unwrap_or_default().to_string();
        let connection = text("connection");
        let location = store
            .source(&connection, &text("schema"), &text("table"))
            .map_err(|e| format!("{label}: {e}; add it with Connect."))?
            .location();
        Ok(Job::OpenDb {
            params: json!({ "connection": connection, "schema": text("schema"), "table": text("table") }),
            connection,
            location,
            label,
        })
    }

    /// Add a Reader for `schema.table` of saved connection `connection`, as clicking it in the
    /// Connect dialog does. False when the connection is unknown (the status says why).
    pub fn open_table(&mut self, connection: &str, schema: &str, table: &str) -> bool {
        let label = format!("{table} ({connection})");
        let params = json!({ "connection": connection, "schema": schema, "table": table });
        match self.open_db_job(&params, label.clone()) {
            Ok(job) => {
                self.send(job);
                self.status = format!("Opening {label}…");
                true
            }
            Err(e) => {
                self.status = e;
                false
            }
        }
    }

    pub(super) fn open_connect(&mut self) {
        let Some(store) = &self.connections else {
            self.status = "Database connections are not available (no configuration directory).".into();
            return;
        };
        let mut dialog = ConnectDialog::default();
        match store.list() {
            Ok(list) => dialog.list = list,
            Err(e) => dialog.message = Some((false, e)),
        }
        if dialog.list.is_empty() {
            dialog.form = Some(Form::new());
        }
        self.connect = Some(dialog);
    }

    pub(super) fn connect_popup(&mut self, ctx: &egui::Context) {
        let (Some(dialog), Some(store)) = (&mut self.connect, self.connections.clone()) else {
            return;
        };
        let mut close = false;
        let mut open = None;
        let response = egui::Modal::new(egui::Id::new("connect")).show(ctx, |ui| {
            ui.set_width(720.0);
            ui.label(egui::RichText::new("Database connections").size(18.0));
            ui.label(
                egui::RichText::new(
                    "PostgreSQL and PostGIS. A graph keeps the connection's name only; the password stays \
                     in this computer's keychain.",
                )
                .small()
                .color(colour::MUTED),
            );
            ui.add_space(8.0);
            ui.horizontal_top(|ui| {
                ui.vertical(|ui| {
                    ui.set_width(190.0);
                    dialog.sidebar(ui, &store);
                });
                ui.separator();
                ui.vertical(|ui| {
                    ui.set_min_height(360.0);
                    if dialog.form.is_some() {
                        dialog.form_ui(ui, &store);
                    } else if let Some(name) = dialog.browsing.clone() {
                        open = dialog.tables_ui(ui, &store, &name);
                    } else {
                        ui.label("Pick a connection, or add one.");
                    }
                });
            });
            dialog.poll();
            ui.separator();
            ui.horizontal(|ui| {
                if ui.button("Close").clicked() {
                    close = true;
                }
                if let Some((good, text)) = &dialog.message {
                    let colour = if *good { colour::ACCENT } else { colour::ERR };
                    ui.colored_label(colour, text);
                }
                if dialog.pending.is_some() {
                    ui.spinner();
                }
            });
        });
        if let Some((connection, info)) = open {
            close = self.open_table(&connection, &info.schema, &info.table);
        }
        if close || response.should_close() {
            self.connect = None;
        }
    }
}

impl ConnectDialog {
    fn sidebar(&mut self, ui: &mut egui::Ui, store: &Arc<Store>) {
        let names: Vec<String> = self.list.iter().map(|c| c.name.clone()).collect();
        for name in names {
            let chosen = self.form.is_none() && self.browsing.as_deref() == Some(&name);
            if ui.selectable_label(chosen, &name).clicked() {
                self.browse(ui.ctx(), store, &name);
            }
        }
        ui.add_space(8.0);
        if ui.button("New connection…").clicked() {
            self.form = Some(Form::new());
            self.message = None;
        }
    }

    fn browse(&mut self, ctx: &egui::Context, store: &Store, name: &str) {
        self.form = None;
        self.browsing = Some(name.to_string());
        self.tables = None;
        self.filter.clear();
        self.message = None;
        match (store.get(name), store.password(name)) {
            (Ok(c), Ok(password)) => {
                self.pending = Some((Purpose::Browse(name.into()), fetch(c.server, password, ctx)));
            }
            (Err(e), _) | (_, Err(e)) => self.tables = Some(Err(e)),
        }
    }

    fn poll(&mut self) {
        let Some((purpose, rx)) = &self.pending else { return };
        let Ok(listing) = rx.try_recv() else { return };
        match purpose {
            Purpose::Browse(name) if self.browsing.as_ref() == Some(name) => self.tables = Some(listing),
            Purpose::Browse(_) => {}
            Purpose::Test => {
                self.message = Some(match listing {
                    Ok(t) => (true, format!("Connected: {} readable tables.", t.len())),
                    Err(e) => (false, e),
                })
            }
        }
        self.pending = None;
    }

    /// The tables of connection `name`; returns the one clicked.
    fn tables_ui(&mut self, ui: &mut egui::Ui, store: &Arc<Store>, name: &str) -> Option<(String, TableInfo)> {
        let connection = self.list.iter().find(|c| c.name == name)?.clone();
        let s = &connection.server;
        ui.label(egui::RichText::new(name).strong());
        ui.label(
            egui::RichText::new(format!("{}@{}:{}/{}", s.user, s.host, s.port, s.database))
                .small()
                .color(colour::MUTED),
        );
        ui.horizontal(|ui| {
            if ui.button("Edit…").clicked() {
                self.form = Some(Form::edit(&connection, store.has_password(name)));
                self.message = None;
            }
            if ui.button("Refresh").clicked() {
                self.browse(ui.ctx(), store, name);
            }
            ui.add(egui::TextEdit::singleline(&mut self.filter).hint_text("Filter tables"));
        });
        ui.add_space(6.0);
        let mut picked = None;
        match &self.tables {
            None => {
                ui.label("Connecting…");
            }
            Some(Err(e)) => {
                ui.colored_label(colour::ERR, e);
            }
            Some(Ok(tables)) if tables.is_empty() => {
                ui.label("No table this user may read.");
            }
            Some(Ok(tables)) => {
                let filter = self.filter.to_lowercase();
                egui::ScrollArea::vertical().max_height(300.0).show(ui, |ui| {
                    for t in tables {
                        let full = format!("{}.{}", t.schema, t.table);
                        if !filter.is_empty() && !full.to_lowercase().contains(&filter) {
                            continue;
                        }
                        let kind = match &t.geometry {
                            Some(g) => format!("  geometry: {g}"),
                            None => "  no geometry".into(),
                        };
                        let text = egui::RichText::new(format!("{full}{kind}"));
                        if ui
                            .add(egui::Button::new(text).frame(false))
                            .on_hover_text("Add a Reader for this table")
                            .clicked()
                        {
                            picked = Some((name.to_string(), t.clone()));
                        }
                    }
                });
            }
        }
        picked
    }
}
