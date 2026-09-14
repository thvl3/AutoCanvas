// Suppress process warnings (notably node:sqlite's ExperimentalWarning on
// Node 22) before anything imports the SQLite module. Import this module first
// in any entry point so the flag is set before `node:sqlite` is loaded.
process.env.NODE_NO_WARNINGS = "1";
