// Sound Color FX, in the RX3's button order. Each module exports `meta` and `Core`; `type` is the firmware's
// EnSoundColorFxType, which SoundColorFxManager (dsp.js ColorManager) indexes its effects by.
import * as space from './space.js';
import * as dubecho from './dubecho.js';
import * as sweep from './sweep.js';
import * as noise from './noise.js';
import * as crush from './crush.js';
import * as filter from './filter.js';

export default [space, dubecho, sweep, noise, crush, filter];
