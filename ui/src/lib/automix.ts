/**
 * Whether a blend waits for the beat of the song that is ending.
 *
 * Shelved: the plain crossfade is what plays. Nothing in the UI offers the
 * switch and this answers false, so no song's opening is downloaded and no
 * blend waits for a beat. The preference (`get_automix`/`set_automix`) and
 * `Player`'s plan and `features/player/lib/tempo.ts`'s pipeline all stay;
 * bringing it back is answering whether a beat can be trusted, not rebuilding
 * it, and the switch would come back alongside them.
 */
export const automixEnabled = () => false;
