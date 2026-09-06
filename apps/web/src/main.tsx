import { Context } from "@plugim/core";
import { chatUiPlugin } from "./plugins/chat-ui";
import { connectionPlugin } from "./plugins/connection";
import { echoBotPlugin } from "./plugins/echo-bot";
import { senderPlugin } from "./plugins/sender";
import "./index.css";

const ctx = new Context({
    info: console.log,
    warn: console.warn,
    error: console.error,
});

ctx.plugin(connectionPlugin);
ctx.plugin(senderPlugin);
ctx.plugin(echoBotPlugin);
ctx.plugin(chatUiPlugin);

void ctx.start();
