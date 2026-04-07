/**
 * LXMF — Lightweight Extensible Message Format.
 *
 * Messaging protocol built on the Reticulum Network Stack.
 * Wire-compatible with the Python reference implementation (github.com/markqvist/LXMF).
 */

export { LXMessage } from './LXMessage.js';
export { LXMRouter } from './LXMRouter.js';
export * from './constants.js';
export {
  FIELD_EMBEDDED_LXMS, FIELD_TELEMETRY, FIELD_TELEMETRY_STREAM,
  FIELD_ICON_APPEARANCE, FIELD_FILE_ATTACHMENTS, FIELD_IMAGE,
  FIELD_AUDIO, FIELD_THREAD, FIELD_COMMANDS, FIELD_RESULTS,
  FIELD_GROUP, FIELD_TICKET, FIELD_EVENT, FIELD_RNR_REFS,
  FIELD_RENDERER, FIELD_CUSTOM_TYPE, FIELD_CUSTOM_DATA, FIELD_CUSTOM_META,
  RENDERER_PLAIN, RENDERER_MICRON, RENDERER_MARKDOWN,
  OPPORTUNISTIC, DIRECT, PROPAGATED,
  DESTINATION_LENGTH, SIGNATURE_LENGTH, LXMF_OVERHEAD,
} from './LXMessage.js';
