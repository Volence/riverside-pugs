import { createHash } from 'node:crypto';
import { camSlots, CANVAS } from './layout.js';
import { SCENES, SCENE_LABELS, type CasterLine, type SceneKey } from './types.js';

/**
 * A ready-made OBS scene collection (plan ruling 9): one scene per overlay,
 * each holding a full-frame browser source on the caster's own overlay URL,
 * plus a "Program" scene with the follow-the-panel source and caster cams
 * placed inside the casters scene's frames (ruling 11). Import it in OBS
 * under Scene Collection > Import.
 *
 * UUIDs are derived from the scene key, so re-importing a newer download
 * replaces sources rather than duplicating them.
 */

export const SCENE_PREFIX = 'RS ';

/** OBS scene name for a scene key, as the panel's OBS client switches to it. */
export function obsSceneName(key: SceneKey | 'program'): string {
  return `${SCENE_PREFIX}${key === 'program' ? 'Program' : SCENE_LABELS[key]}`;
}

function uuid(seed: string): string {
  const h = createHash('sha256').update(`riverside-cast:${seed}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function browserSource(name: string, url: string, w: number, h: number) {
  return {
    prev_ver: 0, name, uuid: uuid(`src:${name}`), versioned_id: 'browser_source', id: 'browser_source',
    settings: { url, width: w, height: h, css: '', reroute_audio: false, shutdown: false, restart_when_active: false },
    mixers: 0, sync: 0, flags: 0, volume: 1, deinterlace_mode: 0, deinterlace_field_order: 0, monitoring_type: 0,
    private_settings: {},
  };
}

function item(source: { name: string; uuid: string }, id: number, x: number, y: number, w: number, h: number) {
  return {
    name: source.name, source_uuid: source.uuid, pos: { x, y }, scale: { x: 1, y: 1 }, rot: 0, alignment: 5,
    bounds_type: 2, bounds_alignment: 0, bounds: { x: w, y: h },
    crop_left: 0, crop_top: 0, crop_right: 0, crop_bottom: 0, id, group_item_backup: false,
    scale_filter: 'disable', blend_type: 'normal', visible: true, locked: false,
  };
}

function scene(name: string, items: ReturnType<typeof item>[]) {
  return {
    prev_ver: 0, name, uuid: uuid(`scene:${name}`), versioned_id: 'scene', id: 'scene',
    settings: { items, custom_size: false, id_counter: items.length },
    mixers: 0, sync: 0, flags: 0, volume: 1, deinterlace_mode: 0, deinterlace_field_order: 0, monitoring_type: 0,
    private_settings: {},
  };
}

export function obsCollection(o: { overlayUrl: (key: string) => string; casters: CasterLine[] }): object {
  const sources: object[] = [];
  const scenes: object[] = [];
  const order: { name: string }[] = [];
  const add = (key: SceneKey | 'program', extra: ReturnType<typeof item>[] = []) => {
    const label = key === 'program' ? 'Program' : SCENE_LABELS[key];
    const bs = browserSource(`RS ${label} overlay`, o.overlayUrl(key), CANVAS.w, CANVAS.h);
    sources.push(bs);
    const name = obsSceneName(key);
    scenes.push(scene(name, [...extra, item(bs, extra.length + 1, 0, 0, CANVAS.w, CANVAS.h)]));
    order.push({ name });
  };
  add('program');
  for (const key of SCENES) {
    if (key !== 'casters') { add(key); continue; }
    const cams = o.casters.filter((c) => c.camUrl);
    const slots = camSlots(cams.length);
    const camItems = cams.map((c, i) => {
      const s = slots[i]!;
      const src = browserSource(`RS Cam ${i + 1}${c.name ? ` (${c.name})` : ''}`, c.camUrl, s.w, s.h);
      sources.push(src);
      return item(src, i + 1, s.x, s.y, s.w, s.h);
    });
    add('casters', camItems);
  }
  return {
    name: 'Riverside Cast',
    current_scene: order[0]!.name,
    current_program_scene: order[0]!.name,
    scene_order: order,
    groups: [], quick_transitions: [], transitions: [], saved_projectors: [],
    current_transition: 'Fade', transition_duration: 300,
    preview_locked: false, scaling_enabled: false, scaling_level: 0, scaling_off_x: 0, scaling_off_y: 0,
    modules: {},
    sources: [...sources, ...scenes],
  };
}
