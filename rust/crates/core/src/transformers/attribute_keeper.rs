use crate::{Ctx, Kind, Param, Ports, Result, Transformer, qid};

pub struct AttributeKeeper;

/// `columnList`: the listed attributes, quoted, comma-separated.
pub(super) fn column_list(ctx: &Ctx) -> String {
    ctx.strings("columns")
        .iter()
        .map(|c| qid(c))
        .collect::<Vec<_>>()
        .join(", ")
}

impl Transformer for AttributeKeeper {
    fn id(&self) -> &'static str {
        "AttributeKeeper"
    }

    fn summary(&self) -> &'static str {
        "Keeps only the listed attributes, in the order you list them."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "columns",
            "Attributes to keep",
            Kind::Columns { port: "input" },
            "The attributes to keep, in the order they should come out; every other attribute is dropped.",
        )];
        P
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let kept = column_list(ctx);
        let kept = if kept.is_empty() { "*" } else { &kept };
        Ok(Ports::from([(
            "output".into(),
            format!("SELECT {kept} FROM {}", ctx.input("input")),
        )]))
    }
}
