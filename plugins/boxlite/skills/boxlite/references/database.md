# When the app needs a database

Choose from the existing app's needs. SQLite can use /workspace/boxlite-app/data; concurrent/server workloads may need PostgreSQL or an existing managed database. Do not introduce a database without an application need.

Keep database files outside releases and /tmp. Guest persistence lasts with the Box; deletion deletes its database. Capacity and per-Box limits come from the organization. A managed volume has a separate lifetime and does not enlarge the guest database disk.

Never register database/admin ports as public tunnels. An inbound-enabled Box can expose unregistered listeners on older production proxies: lack of registration is not a privacy boundary. For PostgreSQL colocated with a public app, default to a Unix socket with TCP disabled (listen_addresses = '') until per-port enforcement is verified on that deployment. Keep database authentication and backend authorization; check external inaccessibility before claiming isolation.

Verify committed data after redeploy and stop/start. Back up live SQLite with its backup API or quiesced WAL writers; use PostgreSQL's native dump/restore. Keep recovery copies outside the Box and rehearse restore.
