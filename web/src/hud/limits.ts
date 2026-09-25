/**
 * How big an image a design may carry: the uploaded style images and an
 * uploaded crosshair share these caps. A leaf module, so the Crosshair page
 * can check a crosshair against them without loading the HUD editor's
 * preset files through design.ts.
 */
export const MAX_IMAGE_SIDE = 512;
/** Base64 characters, about 1 MB decoded. */
export const MAX_IMAGE_B64 = 1_400_000;
