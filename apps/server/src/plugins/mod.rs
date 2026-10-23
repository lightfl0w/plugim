pub mod admin;
pub mod auth;
pub mod bots;
pub mod chat;
pub mod files;
pub mod funds;
pub mod friends;
pub mod group;
pub mod group_files;
pub mod install;
pub mod moments;
pub mod org;
pub mod prefs;
pub mod push;
pub mod s3;
pub mod screen;
pub mod stickers;
pub mod update;

use crate::state::Registry;

pub fn install(registry: &mut Registry) {
    auth::register(registry);
    friends::register(registry);
    group::register(registry);
    group_files::register(registry);
    install::register(registry);
    bots::register(registry);
    chat::register(registry);
    files::register(registry);
    funds::register(registry);
    admin::register(registry);
    moments::register(registry);
    org::register(registry);
    stickers::register(registry);
    prefs::register(registry);
    push::register(registry);
    screen::register(registry);
    update::register(registry);
}
