import { StyleSheet, Text, View } from 'react-native';

import type { LatLng } from '@/utils/polyline';

type RouteMapProps = {
  pickup: LatLng;
  dropoff?: LatLng | null;
  driver?: LatLng | null;
  approachPolyline?: string;
  tripPolyline?: string;
  height?: number;
};

/** MapLibre React Native is native-only; the web console keeps the route summary. */
export function RouteMap({ height = 220 }: RouteMapProps) {
  return (
    <View style={[styles.placeholder, { height }]}>
      <Text style={styles.text}>Route map is available in the mobile app.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#D9E2DE',
    backgroundColor: '#F4F7F5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { color: '#68736F', fontSize: 13 },
});
