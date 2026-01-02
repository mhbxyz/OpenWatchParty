mod messaging;
mod room;
mod types;
mod utils;
mod ws;

use warp::Filter;
use crate::types::{Clients, Rooms};

#[tokio::main]
async fn main() {
    let clients: Clients = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));
    let rooms: Rooms = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashMap::new()));

    let clients_filter = warp::any().map(move || clients.clone());
    let rooms_filter = warp::any().map(move || rooms.clone());

    let ws_route = warp::path("ws")
        .and(warp::ws())
        .and(clients_filter)
        .and(rooms_filter)
        .map(|ws: warp::ws::Ws, clients, rooms| {
            ws.on_upgrade(move |socket| ws::client_connection(socket, clients, rooms))
        });

    println!("OpenSyncParty Rust Server running on 0.0.0.0:3000");
    warp::serve(ws_route).run(([0, 0, 0, 0], 3000)).await;
}
