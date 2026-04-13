// Manual mock for firebase-functions/logger
// Uses no-op functions so tests that don't need to assert on logger calls still work.
// Tests that need spy assertions should jest.mock('firebase-functions/logger') locally.
const noop = () => {};

const logger = { info: noop, warn: noop, error: noop, debug: noop, write: noop, log: noop };

module.exports = { 
    info: noop, 
    warn: noop, 
    error: noop, 
    debug: noop, 
    write: noop, 
    log: noop,
    logger,
    logger_exports: logger
};
