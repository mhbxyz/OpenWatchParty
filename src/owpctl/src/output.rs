use serde::Serialize;

use crate::diagnostics::{CheckStatus, DiagnosticReport};

pub fn print<T: Serialize>(value: &T, _json: bool) -> anyhow::Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

pub fn print_diagnostics(report: &DiagnosticReport, json: bool) -> anyhow::Result<()> {
    if json {
        return print(report, true);
    }
    for check in &report.checks {
        let marker = match check.status {
            CheckStatus::Pass => "OK",
            CheckStatus::Warning => "WARN",
            CheckStatus::Fail => "FAIL",
        };
        println!("{marker:4} {:20} {}", check.id, check.summary);
    }
    println!("Overall: {:?}", report.overall);
    Ok(())
}
