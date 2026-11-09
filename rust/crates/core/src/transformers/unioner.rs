use crate::{Ctx, Ports, Result, Transformer};

pub struct Unioner;

impl Transformer for Unioner {
    fn id(&self) -> &'static str {
        "Unioner"
    }

    fn summary(&self) -> &'static str {
        "Stacks two streams into one; columns are matched by name, missing ones become NULL."
    }

    fn inputs(&self) -> &'static [&'static str] {
        &["top", "bottom"]
    }

    fn sql(&self, ctx: &Ctx) -> Result<Ports> {
        Ok(Ports::from([(
            "output".into(),
            format!(
                "SELECT * FROM {} UNION ALL BY NAME SELECT * FROM {}",
                ctx.input("top"),
                ctx.input("bottom")
            ),
        )]))
    }
}
