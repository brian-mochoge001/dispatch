import { useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map,
  Marker,
  type CameraRef,
} from '@maplibre/maplibre-react-native';

import { decodePolyline, type LatLng } from '@/utils/polyline';
import { MAPLIBRE_STYLE } from './map-style';

type RouteMapProps = {
  pickup: LatLng;
  dropoff?: LatLng | null;
  driver?: LatLng | null;
  /** Driver -> pickup, drawn as a dashed approach line. */
  approachPolyline?: string;
  /** Pickup -> dropoff, drawn as the active trip line. */
  tripPolyline?: string;
  height?: number;
};

function lineFeature(
  points: LatLng[],
  label: string,
): GeoJSON.Feature<GeoJSON.LineString> | null {
  if (points.length < 2) return null;
  return {
    type: 'Feature',
    properties: { label },
    geometry: {
      type: 'LineString',
      coordinates: points.map((point) => [point.longitude, point.latitude]),
    },
  };
}

export function RouteMap({
  pickup,
  dropoff,
  driver,
  approachPolyline,
  tripPolyline,
  height = 220,
}: RouteMapProps) {
  const cameraRef = useRef<CameraRef>(null);

  const approach = useMemo(
    () => (approachPolyline ? decodePolyline(approachPolyline) : []),
    [approachPolyline],
  );
  const trip = useMemo(
    () => (tripPolyline ? decodePolyline(tripPolyline) : []),
    [tripPolyline],
  );

  const approachFeature = useMemo(() => lineFeature(approach, 'approach'), [approach]);
  const tripFeature = useMemo(() => lineFeature(trip, 'trip'), [trip]);

  // Fit when the job or its route changes, not on every 5-second location ping;
  // otherwise the camera would jump while the driver is moving.
  const lastFitKey = useRef('');
  const fitKey = [
    pickup.latitude,
    pickup.longitude,
    dropoff?.latitude ?? '',
    dropoff?.longitude ?? '',
    tripPolyline ? tripPolyline.slice(0, 32) : '',
  ].join(':');

  useEffect(() => {
    if (lastFitKey.current === fitKey) return;
    lastFitKey.current = fitKey;

    const points: LatLng[] = [];
    if (trip.length > 1) points.push(...trip);
    else {
      points.push(pickup);
      if (dropoff) points.push(dropoff);
    }
    if (driver) points.push(driver);
    if (points.length < 2) return;

    const latitudes = points.map((point) => point.latitude);
    const longitudes = points.map((point) => point.longitude);
    const bounds: [number, number, number, number] = [
      Math.min(...longitudes),
      Math.min(...latitudes),
      Math.max(...longitudes),
      Math.max(...latitudes),
    ];

    cameraRef.current?.fitBounds(bounds, {
      padding: { top: 40, right: 40, bottom: 40, left: 40 },
      duration: 500,
    });
  }, [driver, fitKey, pickup, dropoff, trip]);

  return (
    <View style={[styles.card, { height }]}>
      {/* The console is a ScrollView; a non-interactive map keeps vertical
          scrolling working while still showing the route. */}
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        <Map
          style={StyleSheet.absoluteFill}
          mapStyle={MAPLIBRE_STYLE}
          logo={false}
          compass={false}
          attribution={false}
          touchZoom={false}
          doubleTapZoom={false}
          doubleTapHoldZoom={false}
          touchRotate={false}
          touchPitch={false}
        >
          <Camera
            ref={cameraRef}
            initialViewState={{
              center: [pickup.longitude, pickup.latitude],
              zoom: 13,
            }}
          />

          {approachFeature ? (
            <GeoJSONSource id="dispatch-approach-source" data={approachFeature}>
              <Layer
                id="dispatch-approach-line"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{
                  'line-color': '#7A8B85',
                  'line-width': 3,
                  'line-dasharray': [2, 2],
                }}
              />
            </GeoJSONSource>
          ) : null}

          {tripFeature ? (
            <GeoJSONSource id="dispatch-trip-source" data={tripFeature}>
              <Layer
                id="dispatch-trip-line"
                type="line"
                layout={{ 'line-cap': 'round', 'line-join': 'round' }}
                paint={{ 'line-color': '#0a7ea4', 'line-width': 5 }}
              />
            </GeoJSONSource>
          ) : null}

          <Marker lngLat={[pickup.longitude, pickup.latitude]} anchor="center">
            <View style={styles.pickupDot} />
          </Marker>

          {dropoff ? (
            <Marker lngLat={[dropoff.longitude, dropoff.latitude]} anchor="center">
              <View style={styles.dropoffDot} />
            </Marker>
          ) : null}

          {driver ? (
            <Marker lngLat={[driver.longitude, driver.latitude]} anchor="center">
              <View style={styles.driverDot} />
            </Marker>
          ) : null}
        </Map>
      </View>

      <Text style={styles.attribution}>© OpenStreetMap contributors</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 10,
    overflow: 'hidden',
    backgroundColor: '#E6EEEA',
    borderWidth: 1,
    borderColor: '#D9E2DE',
  },
  pickupDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#147D69',
    borderWidth: 3,
    borderColor: '#fff',
  },
  dropoffDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#C2413A',
    borderWidth: 3,
    borderColor: '#fff',
  },
  driverDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#147D69',
    borderWidth: 3,
    borderColor: '#fff',
  },
  attribution: {
    position: 'absolute',
    right: 6,
    bottom: 5,
    backgroundColor: 'rgba(255,255,255,0.8)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 3,
    fontSize: 9,
    color: '#333',
  },
});
