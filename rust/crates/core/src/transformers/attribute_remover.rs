use super::attribute_keeper::column_list;
use crate::{Ctx, Kind, Param, Ports, Result, Transformer};

pub struct AttributeRemover;

impl Transformer for AttributeRemover {
    fn id(&self) -> &'static str {
        "AttributeRemover"
    }

    fn summary(&self) -> &'static str {
        "Drops the listed attributes and keeps all the others, in their order."
    }

    fn params(&self) -> &'static [Param] {
        const P: &[Param] = &[Param::new(
            "columns",
            "Attributes to remove",
            Kind::Columns { port: "input" },
            "The attributes to drop from every row; all the other attributes are kept in their order.",
        )];
        P
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        let dropped = column_list(ctx);
        let selection = if dropped.is_empty() {
            "*".into()
        } else {
            format!("* EXCLUDE ({dropped})")
        };
        Ok(Ports::from([(
            "output".into(),
            format!("SELECT {selection} FROM {}", ctx.input("input")),
        )]))
    }
}
