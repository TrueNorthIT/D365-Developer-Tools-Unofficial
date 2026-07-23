// Decides whether a resolved icon image is monochrome (black/grey/white line art, the vast
// majority of Dataverse's ribbon icon set) as opposed to a genuinely colorful one (a handful of
// icons with color accents, or a custom uploaded icon). Used to invert only the former under a
// dark VS Code theme -- the icons are drawn for a light background and disappear against the dark
// ribbon card otherwise -- without also inverting (and hue-shifting) icons that already have color.
//
// There's no CSS-only way to ask "is this image mostly grayscale": a `filter: invert()` applies
// uniformly to every pixel regardless of content. This draws the image into an offscreen canvas and
// measures each pixel's chroma (the spread between its highest and lowest RGB channel -- 0 for true
// grays, higher for saturated colors), skipping transparent pixels, and calls it monochrome if the
// average chroma stays under a small threshold (anti-aliased edges land a few units above 0, but
// nowhere near a real color).
const SAMPLE_SIZE = 24;
const MONOCHROME_CHROMA_THRESHOLD = 24;
const TRANSPARENT_ALPHA_THRESHOLD = 32;

export function isMonochromeImage(dataUri: string): Promise<boolean> {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = SAMPLE_SIZE;
            canvas.height = SAMPLE_SIZE;
            const ctx = canvas.getContext('2d');
            if (!ctx) { resolve(true); return; }

            ctx.drawImage(img, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

            try {
                const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
                let totalChroma = 0;
                let sampled = 0;
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] < TRANSPARENT_ALPHA_THRESHOLD) { continue; }
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    totalChroma += Math.max(r, g, b) - Math.min(r, g, b);
                    sampled++;
                }
                resolve(sampled === 0 || totalChroma / sampled < MONOCHROME_CHROMA_THRESHOLD);
            } catch {
                // Can't read pixel data (a tainted canvas, in principle -- shouldn't happen for a
                // data: URI) -- leave the icon alone rather than risk inverting something we
                // couldn't actually verify is monochrome.
                resolve(false);
            }
        };
        img.onerror = () => resolve(false);
        img.src = dataUri;
    });
}
