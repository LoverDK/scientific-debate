import { runMigrations } from "@agent-native/core/db";

import {
  DEBATES_APP_MIGRATIONS_TABLE,
  debatesAppMigrations,
} from "../db/migrations.js";

export default runMigrations(debatesAppMigrations, {
  table: DEBATES_APP_MIGRATIONS_TABLE,
});
