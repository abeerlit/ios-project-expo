/**
 * JsSIP loader - fixes iOS module resolution where default import can be undefined.
 * jssip 3.13.x uses CommonJS named exports; Metro/Babel on iOS may not resolve
 * "import jssip from 'jssip'" correctly. require() works reliably with CommonJS.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const jssip = require("jssip");
export default jssip;
