import { handle } from "hono/aws-lambda";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const { app } = createApp(loadConfig());

export const handler = handle(app);
