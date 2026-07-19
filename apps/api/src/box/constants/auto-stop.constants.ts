// PostgreSQL `int` is a signed 32-bit integer. Keep the API boundary aligned
// with the column so accepted values can always be persisted safely.
export const MAX_AUTO_STOP_INTERVAL_SECONDS = 2_147_483_647
