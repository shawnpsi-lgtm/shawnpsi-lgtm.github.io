// Beat FX, in the RX3's menu order. Add an effect: create ./<name>.js (see ../README.md) and import it here.
import * as echo from './echo.js';
import * as reverb from './reverb.js';
import * as flanger from './flanger.js';
import * as phaser from './phaser.js';
import * as filter from './filter.js';
import * as trans from './trans.js';
// not on the RX3: from shawnsingh.me/beatfx
import * as drum from './drum.js';
import * as noise from './noise.js';

export default [echo, reverb, flanger, phaser, filter, trans, drum, noise];
