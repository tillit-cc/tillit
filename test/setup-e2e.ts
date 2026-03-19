// Set deployment mode BEFORE any module is imported
// This ensures PushToken entity uses 'varchar' instead of 'enum' for SQLite compatibility
process.env.DEPLOYMENT_MODE = 'selfhosted';
