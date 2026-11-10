/**
 * MapLibre basemap configuration for the driver console.
 *
 * The fallback is an OpenStreetMap raster style, which needs no Google Maps
 * SDK or API key. Set EXPO_PUBLIC_MAPLIBRE_STYLE_URL to a self-hosted vector
 * style in production, and EXPO_PUBLIC_OSM_TILE_URL to a production raster
 * provider if you keep the fallback.
 */
export const OSM_RASTER_STYLE = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: [
        process.env.EXPO_PUBLIC_OSM_TILE_URL ||
          'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      ],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
    },
  ],
} as const;

export const MAPLIBRE_STYLE =
  process.env.EXPO_PUBLIC_MAPLIBRE_STYLE_URL ||
  (OSM_RASTER_STYLE as unknown as string);
