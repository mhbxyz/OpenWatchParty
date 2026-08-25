use serde::Serialize;

pub fn print<T: Serialize>(value: &T, _json: bool) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}
