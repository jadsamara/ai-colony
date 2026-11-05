import { maintenanceDatabaseUrl, resolveIntegrationDatabaseUrl } from "./isolation.js";

const integrationDatabaseUrl = resolveIntegrationDatabaseUrl(process.env);

export const TEST_DATABASE_URL = integrationDatabaseUrl;
export const ADMIN_DATABASE_URL = maintenanceDatabaseUrl(integrationDatabaseUrl);
