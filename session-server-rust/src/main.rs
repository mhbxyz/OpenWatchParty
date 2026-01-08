mod messaging;
mod room;
mod types;
mod utils;
mod ws;

use warp::Filter;
use crate::types::{Clients, Rooms};

fn get_allowed_origins() -> Vec<String> {
    std::env::var("ALLOWED_ORIGINS")
        .unwrap_or_else(|_| "http://localhost:8096,https://localhost:8096".to_string())
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn is_origin_allowed(origin: &str, allowed: &[String]) -> bool {
    if allowed.iter().any(|o| o == "*") {
        return true;
    }
    allowed.iter().any(|o| o == origin)
}

#[tokio::main]
async fn main() {
    let allowed_origins = get_allowed_origins();
    println!("[server] Allowed origins: {:?}", allowed_origins);

    let clients: Clients = std::sync::Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));
    let rooms: Rooms = std::sync::Arc::new(tokio::sync::RwLock::new(std::collections::HashMap::new()));

    let clients_filter = warp::any().map(move || clients.clone());
    let rooms_filter = warp::any().map(move || rooms.clone());

    let allowed_origins_filter = {
        let origins = allowed_origins.clone();
        warp::any().map(move || origins.clone())
    };

    // Origin validation filter
    let origin_check = warp::header::optional::<String>("origin")
        .and(allowed_origins_filter.clone())
        .and_then(|origin: Option<String>, allowed: Vec<String>| async move {
            match origin {
                Some(ref o) if is_origin_allowed(o, &allowed) => Ok(()),
                Some(o) => {
                    eprintln!("[server] Rejected connection from origin: {}", o);
                    Err(warp::reject::custom(OriginRejected))
                }
                None => Ok(()), // Allow connections without Origin header (non-browser clients)
            }
        })
        .untuple_one();

    // WebSocket route with Origin validation
    let ws_route = warp::path("ws")
        .and(origin_check)
        .and(warp::ws())
        .and(clients_filter)
        .and(rooms_filter)
        .map(|ws: warp::ws::Ws, clients, rooms| {
            ws.on_upgrade(move |socket| ws::client_connection(socket, clients, rooms))
        });

    // Health check endpoint with CORS
    let cors = warp::cors()
        .allow_origins(allowed_origins.iter().map(|s| s.as_str()).collect::<Vec<_>>())
        .allow_methods(vec!["GET"])
        .allow_headers(vec!["content-type"]);

    let health_route = warp::path("health")
        .and(warp::get())
        .map(|| warp::reply::json(&serde_json::json!({"status": "ok"})))
        .with(cors);

    let routes = ws_route.or(health_route);

    println!("OpenSyncParty Rust Server running on 0.0.0.0:3000");
    warp::serve(routes).run(([0, 0, 0, 0], 3000)).await;
}

#[derive(Debug)]
struct OriginRejected;
impl warp::reject::Reject for OriginRejected {}
