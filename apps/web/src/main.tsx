import { Context } from "@plugim/core";
import { authPlugin } from "./plugins/auth";
import { connectionPlugin } from "./plugins/connection";
import { friendsPlugin } from "./plugins/friends";
import { senderPlugin } from "./plugins/sender";
import { shellPlugin } from "./plugins/shell";
import { uiAuthPlugin } from "./plugins/ui-auth";
import { uiComposerPlugin } from "./plugins/ui-composer";
import { uiFriendsPanelPlugin } from "./plugins/ui-friends-panel";
import { uiHeaderPlugin } from "./plugins/ui-header";
import { uiMessagesPlugin } from "./plugins/ui-messages";
import { uiSidebarPlugin } from "./plugins/ui-sidebar";
import "./index.css";

const ctx = new Context({
    info: console.log,
    warn: console.warn,
    error: console.error,
});

ctx.plugin(authPlugin);
ctx.plugin(connectionPlugin);
ctx.plugin(senderPlugin);
ctx.plugin(friendsPlugin);
ctx.plugin(shellPlugin);
ctx.plugin(uiAuthPlugin);
ctx.plugin(uiSidebarPlugin);
ctx.plugin(uiHeaderPlugin);
ctx.plugin(uiMessagesPlugin);
ctx.plugin(uiComposerPlugin);
ctx.plugin(uiFriendsPanelPlugin);

void ctx.start();
