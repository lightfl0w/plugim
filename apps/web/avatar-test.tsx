import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { UserAvatar } from "./src/components/ui/user-avatar";

const html = renderToStaticMarkup(
    React.createElement(UserAvatar, { name: "alice" }),
);
console.log(html);
