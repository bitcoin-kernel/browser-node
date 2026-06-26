// Re-export the encoders used across the SwiftSync modules (validate.js imports
// encodeOutpoint from here). Mirrors @bitcoin-kernel/swiftsync index.js surface.
export { encodeOutpoint } from './outpoint.js';
