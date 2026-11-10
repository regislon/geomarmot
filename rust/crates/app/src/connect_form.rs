//! The Connect dialog's form: add or edit a saved connection, test it, delete it.

use std::sync::Arc;

use geomarmot_connections::{Connection, Store};
use geomarmot_sql::pg::{PgServer, SslMode};

use super::{ConnectDialog, Purpose, fetch};
use crate::canvas::colour;

#[derive(Default)]
pub(super) struct Form {
    /// The saved name being edited; None for a new connection.
    original: Option<String>,
    name: String,
    host: String,
    port: String,
    database: String,
    user: String,
    password: String,
    sslmode: SslMode,
    has_password: bool,
    confirm_delete: bool,
}

impl Form {
    pub(super) fn new() -> Self {
        Self {
            host: "localhost".into(),
            port: "5432".into(),
            ..Self::default()
        }
    }

    pub(super) fn edit(c: &Connection, has_password: bool) -> Self {
        let s = &c.server;
        Self {
            original: Some(c.name.clone()),
            name: c.name.clone(),
            host: s.host.clone(),
            port: s.port.to_string(),
            database: s.database.clone(),
            user: s.user.clone(),
            sslmode: s.sslmode,
            has_password,
            ..Self::default()
        }
    }

    pub(super) fn connection(&self) -> Result<Connection, String> {
        let port = self
            .port
            .trim()
            .parse()
            .map_err(|_| "The port is a number, 5432 by default.")?;
        if self.host.trim().is_empty() || self.database.trim().is_empty() || self.user.trim().is_empty() {
            return Err("Host, database and user are needed.".into());
        }
        Ok(Connection {
            name: self.name.trim().to_string(),
            server: PgServer {
                host: self.host.trim().into(),
                port,
                database: self.database.trim().into(),
                user: self.user.trim().into(),
                sslmode: self.sslmode,
            },
        })
    }

    /// What to store: a typed password; for an edited connection, nothing typed keeps the saved one.
    pub(super) fn password(&self) -> Option<&str> {
        match (&self.original, self.password.is_empty()) {
            (Some(_), true) => None,
            _ => Some(&self.password),
        }
    }
}

impl ConnectDialog {
    pub(super) fn form_ui(&mut self, ui: &mut egui::Ui, store: &Arc<Store>) {
        let Some(form) = &mut self.form else { return };
        let editing = form.original.is_some();
        ui.label(egui::RichText::new(if editing { "Edit connection" } else { "New connection" }).strong());
        egui::Grid::new("connect-form")
            .num_columns(2)
            .spacing([10.0, 6.0])
            .show(ui, |ui| {
                ui.label("Name");
                ui.add_enabled(
                    !editing,
                    egui::TextEdit::singleline(&mut form.name).hint_text("e.g. office-gis"),
                );
                ui.end_row();
                for (label, value) in [
                    ("Host", &mut form.host),
                    ("Port", &mut form.port),
                    ("Database", &mut form.database),
                    ("User", &mut form.user),
                ] {
                    ui.label(label);
                    ui.text_edit_singleline(value);
                    ui.end_row();
                }
                ui.label("Password");
                let hint = if form.has_password {
                    "saved in the keychain; type to replace"
                } else {
                    "kept in the system keychain"
                };
                ui.add(
                    egui::TextEdit::singleline(&mut form.password)
                        .password(true)
                        .hint_text(hint),
                );
                ui.end_row();
                ui.label("TLS");
                egui::ComboBox::from_id_salt("sslmode")
                    .selected_text(form.sslmode.as_str())
                    .show_ui(ui, |ui| {
                        for mode in SslMode::ALL {
                            ui.selectable_value(&mut form.sslmode, mode, mode.as_str());
                        }
                    });
                ui.end_row();
            });
        ui.label(
            egui::RichText::new(
                "prefer: TLS when the server offers it. require: TLS with a certificate this computer trusts.",
            )
            .small()
            .color(colour::MUTED),
        );
        ui.add_space(8.0);
        let (mut test, mut save, mut delete, mut cancel) = (false, false, false, false);
        ui.horizontal(|ui| {
            test = ui.button("Test").clicked();
            save = ui.button("Save").clicked();
            if editing {
                let text = if form.confirm_delete {
                    "Really delete?"
                } else {
                    "Delete"
                };
                delete = ui.button(text).clicked();
            }
            cancel = ui.button("Cancel").clicked();
        });
        if test {
            let password = match (form.password(), &form.original) {
                (Some(p), _) => Ok(p.to_string()),
                (None, Some(name)) => store.password(name),
                (None, None) => Ok(String::new()),
            };
            match (form.connection(), password) {
                (Ok(c), Ok(p)) => {
                    self.message = None;
                    self.pending = Some((Purpose::Test, fetch(c.server, p, ui.ctx())));
                }
                (Err(e), _) | (_, Err(e)) => self.message = Some((false, e)),
            }
        } else if save {
            let saved = form
                .connection()
                .and_then(|c| store.save(&c, form.password()).map(|_| c.name));
            match saved {
                Ok(name) => {
                    self.list = store.list().unwrap_or_default();
                    self.browse(ui.ctx(), store, &name);
                    self.message = Some((true, format!("Saved {name}.")));
                }
                Err(e) => self.message = Some((false, e)),
            }
        } else if delete && !form.confirm_delete {
            form.confirm_delete = true;
        } else if delete && let Some(name) = form.original.clone() {
            match store.remove(&name) {
                Ok(()) => {
                    self.list = store.list().unwrap_or_default();
                    self.form = None;
                    self.browsing = None;
                    self.message = Some((true, format!("Deleted {name} and its password.")));
                }
                Err(e) => self.message = Some((false, e)),
            }
        } else if cancel {
            self.form = None;
        }
    }
}
