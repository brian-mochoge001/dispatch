import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  useColorScheme,
  View,
} from 'react-native';
import { RouteMap } from '@/components/route-map';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Spacing } from '@/constants/theme';
import {
  DriverRequest,
  DriverSession,
  Location,
  cancelDelivery,
  cancelRide,
  captureProofPhoto,
  completeDelivery,
  completeRide,
  getActiveTasks,
  getRequests,
  getRoute,
  loadDriverSession,
  pickupDelivery,
  respondToRequest,
  setDriverAvailability,
  signInDriver,
  signOutDriver,
  startRide,
  subscribeToDriverEvents,
  updateDriverLocation,
} from '@/services/driver-api';

/** Statuses that mean "the driver is currently holding this job". */
const ACTIVE_STATUSES = ['accepted', 'in_transit', 'assigned', 'picked_up', 'out_for_delivery'];

const STATUS_LABELS: Record<string, string> = {
  assigned: 'Assigned',
  accepted: 'Accepted',
  in_transit: 'On the way',
  picked_up: 'Picked up',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
  requested: 'Requested',
};

function labelFor(status: string) {
  return STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

function isDelivery(request: DriverRequest) {
  return request.service_type === 'delivery';
}

function distanceToPickup(request: DriverRequest) {
  if (typeof request.distance_m !== 'number') return null;
  if (request.distance_m < 1000) return `${Math.round(request.distance_m)} m to pickup`;
  return `${(request.distance_m / 1000).toFixed(1)} km to pickup`;
}

/** The courier fee the driver is working for; deliveries price this separately
 * from the basket total. */
function deliveryFee(request: DriverRequest) {
  if (!isDelivery(request) || !request.fare_amount) return null;
  return `${request.fare_currency || request.currency} ${request.fare_amount}`;
}

function deliveryLeg(request: DriverRequest) {
  if (!isDelivery(request) || typeof request.distance_km !== 'number' || request.distance_km <= 0) return null;
  const minutes = typeof request.duration_minutes === 'number' ? Math.round(request.duration_minutes) : null;
  return `${request.distance_km.toFixed(1)} km${minutes != null ? ` · ${minutes} min` : ''}`;
}

export default function HomeScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme === 'dark' ? 'dark' : 'light'];
  const [session, setSession] = useState<DriverSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [isOnline, setIsOnline] = useState(false);
  const [requests, setRequests] = useState<DriverRequest[]>([]);
  const [tasks, setTasks] = useState<DriverRequest[]>([]);
  const [declined, setDeclined] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const [lastLocationAt, setLastLocationAt] = useState<Date | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [driverPosition, setDriverPosition] = useState<{ latitude: number; longitude: number } | null>(null);
  const [tripRoute, setTripRoute] = useState<{ key: string; polyline?: string } | null>(null);
  const [approachRoute, setApproachRoute] = useState<{ key: string; polyline?: string } | null>(null);
  const locationSubscription = useRef<Location.LocationSubscription | null>(null);
  const tripRouteKey = useRef('');
  const approachRouteKey = useRef('');
  const approachRouteAt = useRef(0);

  // The first active task is the one the driver is currently working; the map
  // shows its pickup -> dropoff leg plus the approach to pickup.
  const primaryTask = tasks[0];
  const primaryTripKey = primaryTask
    ? [
        primaryTask.service_type,
        primaryTask.id,
        primaryTask.pickup_location?.latitude,
        primaryTask.pickup_location?.longitude,
        primaryTask.dropoff_location?.latitude,
        primaryTask.dropoff_location?.longitude,
      ].join(':')
    : '';
  const approachKey = primaryTask ? `${primaryTask.id}:${primaryTask.status}` : '';
  const tripRoutePolyline = tripRoute?.key === primaryTripKey ? tripRoute.polyline : undefined;
  const approachRoutePolyline =
    primaryTask &&
    (primaryTask.status === 'accepted' || primaryTask.status === 'assigned') &&
    approachRoute?.key === approachKey
      ? approachRoute.polyline
      : undefined;

  useEffect(() => {
    loadDriverSession().then(setSession).finally(() => setCheckingSession(false));
  }, []);

  const refreshRequests = useCallback(async () => {
    if (!session) return;
    const [nextRequests, nextTasks] = await Promise.all([
      getRequests(session.token),
      getActiveTasks(session.token),
    ]);
    setRequests(nextRequests.filter((request) => !declined.has(request.id)));
    setTasks(nextTasks.filter((task) => ACTIVE_STATUSES.includes(task.status)));
  }, [session, declined]);

  useEffect(() => {
    if (!session || !isOnline) return;
    let mounted = true;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        await refreshRequests();
        if (mounted) setErrorMessage('');
      } catch (error) {
        if (mounted) setErrorMessage(error instanceof Error ? error.message : 'Could not refresh dispatch requests.');
      } finally {
        if (mounted) timeout = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => { mounted = false; clearTimeout(timeout); };
  }, [session, isOnline, refreshRequests]);

  // Push offers arrive on the gateway's SSE stream. A push only triggers an
  // authoritative feed refresh, so a duplicate or replayed event cannot invent
  // a request. The five-second poll above stays as the recovery path.
  useEffect(() => {
    if (!session || !isOnline) return;
    const controller = new AbortController();
    let active = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        await subscribeToDriverEvents(session.token, (event) => {
          if (!active) return;
          if (event.type === 'ride_offer' || event.type === 'delivery_offer') {
            void refreshRequests().catch(() => {});
          }
        }, controller.signal);
      } catch {
        // The stream is best-effort; polling continues while it reconnects.
      }
      if (active) retry = setTimeout(connect, 5000);
    };
    void connect();
    return () => {
      active = false;
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [session, isOnline, refreshRequests]);

  useEffect(() => () => { locationSubscription.current?.remove(); }, []);

  // Fetch the pickup -> dropoff route when the active task changes. The route
  // is independent of the driver's position, so it is safe to cache by key.
  useEffect(() => {
    if (!session || !primaryTask?.dropoff_location) return;
    if (tripRouteKey.current === primaryTripKey) return;
    tripRouteKey.current = primaryTripKey;
    let active = true;
    void getRoute(session.token, primaryTask.pickup_location, primaryTask.dropoff_location)
      .then((route) => {
        if (active) setTripRoute({ key: primaryTripKey, polyline: route?.polyline });
      })
      .catch(() => {
        if (active) {
          setTripRoute({ key: primaryTripKey, polyline: undefined });
          // Retry on the next poll, but do not surface a routing outage as a
          // dispatch error; the markers still render without the line.
          tripRouteKey.current = '';
        }
      });
    return () => { active = false; };
  }, [session, primaryTask, primaryTripKey]);

  // Before pickup, draw a dashed driver -> pickup approach. Refresh it at most
  // every 30 seconds so a moving driver does not hammer the router.
  useEffect(() => {
    if (!session || !primaryTask || !driverPosition) return;
    if (primaryTask.status !== 'accepted' && primaryTask.status !== 'assigned') return;
    const sameTask = approachRouteKey.current === approachKey;
    if (sameTask && Date.now() - approachRouteAt.current < 30_000) return;
    approachRouteKey.current = approachKey;
    approachRouteAt.current = Date.now();
    let active = true;
    void getRoute(session.token, driverPosition, primaryTask.pickup_location)
      .then((route) => {
        if (active) setApproachRoute({ key: approachKey, polyline: route?.polyline });
      })
      .catch(() => {
        if (active) setApproachRoute({ key: approachKey, polyline: undefined });
      });
    return () => { active = false; };
  }, [approachKey, session, primaryTask, driverPosition]);

  const handleSignIn = async () => {
    if (!email.trim() || !password) {
      Alert.alert('Sign in', 'Enter your driver account email and password.');
      return;
    }
    setBusy(true);
    try {
      const nextSession = await signInDriver(email, password);
      setSession(nextSession);
      setPassword('');
    } catch (error) {
      Alert.alert('Could not sign in', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleAvailability = async () => {
    if (!session || busy) return;
    setBusy(true);
    try {
      if (isOnline) {
        locationSubscription.current?.remove();
        locationSubscription.current = null;
        await setDriverAvailability(session.token, 'offline');
        setIsOnline(false);
        setDriverPosition(null);
        setApproachRoute(null);
        approachRouteKey.current = '';
        approachRouteAt.current = 0;
        return;
      }
      const permission = await Location.requestForegroundPermissionsAsync();
      if (!permission.granted) throw new Error('Allow location while using the app before going online.');
      const firstLocation = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      await updateDriverLocation(session.token, firstLocation.coords);
      await setDriverAvailability(session.token, 'online');
      setDriverPosition({ latitude: firstLocation.coords.latitude, longitude: firstLocation.coords.longitude });
      setLastLocationAt(new Date());
      setIsOnline(true);
      locationSubscription.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, timeInterval: 5000, distanceInterval: 20 },
        (position) => {
          setDriverPosition({ latitude: position.coords.latitude, longitude: position.coords.longitude });
          void updateDriverLocation(session.token, position.coords)
            .then(() => setLastLocationAt(new Date()))
            .catch((error) => setErrorMessage(error instanceof Error ? error.message : 'Location update failed.'));
        },
      );
    } catch (error) {
      Alert.alert('Could not change availability', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleRequest = async (request: DriverRequest, accept: boolean) => {
    if (!session) return;
    try {
      if (!accept) {
        // Hide the card immediately. The pass is recorded server-side for both
        // rides and deliveries, so the same offer is not shown again.
        setDeclined((previous) => new Set(previous).add(request.id));
        try {
          await respondToRequest(session.token, request, false);
        } catch (error) {
          setDeclined((previous) => {
            const next = new Set(previous);
            next.delete(request.id);
            return next;
          });
          throw error;
        }
        return;
      }
      await respondToRequest(session.token, request, accept);
      await refreshRequests();
    } catch (error) {
      Alert.alert(accept ? 'Could not accept request' : 'Could not decline request', error instanceof Error ? error.message : 'Please try again.');
    }
  };

  /** Advance an active job by one step, whichever lifecycle it belongs to. */
  const handleAdvance = async (task: DriverRequest) => {
    if (!session) return;
    setBusy(true);
    try {
      if (isDelivery(task)) {
        if (task.status === 'assigned') {
          // Photograph the goods before leaving the merchant. The merchant
          // verifies this photo and releases the order.
          const photoUrl = await captureProofPhoto(session.userId, task.id, 'pickup');
          if (!photoUrl) return;
          await pickupDelivery(session.token, task.id, photoUrl);
        } else if (task.status === 'out_for_delivery') {
          // The dropoff photo soft-completes the order; the customer can still
          // confirm it later.
          const photoUrl = await captureProofPhoto(session.userId, task.id, 'dropoff');
          if (!photoUrl) return;
          await completeDelivery(session.token, task.id, photoUrl);
        }
      } else {
        if (task.status === 'accepted') await startRide(session.token, task.id);
        else if (task.status === 'in_transit') await completeRide(session.token, task.id);
      }
      await refreshRequests();
    } catch (error) {
      Alert.alert('Could not update the job', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleAbandon = async (task: DriverRequest) => {
    if (!session) return;
    try {
      if (isDelivery(task)) await cancelDelivery(session.token, task.id);
      else await cancelRide(session.token, task.id);
      await refreshRequests();
    } catch (error) {
      Alert.alert('Could not release the job', error instanceof Error ? error.message : 'Please try again.');
    }
  };

  const handleSignOut = async () => {
    locationSubscription.current?.remove();
    locationSubscription.current = null;
    if (session && isOnline) await setDriverAvailability(session.token, 'offline').catch(() => undefined);
    await signOutDriver();
    setSession(null);
    setIsOnline(false);
    setRequests([]);
    setTasks([]);
    setDriverPosition(null);
    setTripRoute(null);
    setApproachRoute(null);
    tripRouteKey.current = '';
    approachRouteKey.current = '';
    approachRouteAt.current = 0;
  };

  if (checkingSession) {
    return <ThemedView style={styles.center}><ActivityIndicator size="large" color="#147D69" /></ThemedView>;
  }

  if (!session) {
    return (
      <ThemedView style={styles.page}>
        <View style={styles.loginWrap}>
          <ThemedText type="smallBold" style={styles.eyebrow}>EHUB DRIVER</ThemedText>
          <ThemedText type="title" style={styles.loginTitle}>Sign in to dispatch</ThemedText>
          <ThemedText style={styles.muted}>Use the driver account associated with your eHub profile.</ThemedText>
          <TextInput autoCapitalize="none" autoComplete="email" keyboardType="email-address" placeholder="Email address" value={email} onChangeText={setEmail} style={[styles.input, { color: colors.text, borderColor: colors.backgroundSelected }]} />
          <TextInput secureTextEntry autoComplete="password" placeholder="Password" value={password} onChangeText={setPassword} style={[styles.input, { color: colors.text, borderColor: colors.backgroundSelected }]} />
          <TouchableOpacity disabled={busy} style={[styles.primaryButton, busy && styles.disabled]} onPress={handleSignIn}>
            {busy ? <ActivityIndicator color="#fff" /> : <ThemedText style={styles.buttonText}>Sign in</ThemedText>}
          </TouchableOpacity>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView style={styles.page}>
      <ScrollView contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await refreshRequests().catch(() => undefined); setRefreshing(false); }} />}>
        <View style={styles.topBar}>
          <View>
            <ThemedText type="smallBold" style={styles.eyebrow}>EHUB DISPATCH</ThemedText>
            <ThemedText type="subtitle" style={styles.heading}>Driver console</ThemedText>
          </View>
          <TouchableOpacity onPress={handleSignOut}><ThemedText style={styles.signOut}>Sign out</ThemedText></TouchableOpacity>
        </View>

        <View style={[styles.availability, isOnline && styles.availabilityOnline]}>
          <View style={styles.statusRow}>
            <View style={[styles.statusDot, isOnline && styles.statusDotOnline]} />
            <View style={styles.statusTextWrap}>
              <ThemedText type="smallBold">{isOnline ? 'Available for requests' : 'You are offline'}</ThemedText>
              <ThemedText style={styles.muted}>{isOnline ? 'Location is shared while this app is open.' : 'Go online when you are ready to drive.'}</ThemedText>
            </View>
            <TouchableOpacity disabled={busy} onPress={handleAvailability} style={[styles.availabilityButton, isOnline && styles.offlineButton, busy && styles.disabled]}>
              <ThemedText style={[styles.availabilityButtonText, isOnline && styles.offlineButtonText]}>{busy ? '...' : isOnline ? 'Go offline' : 'Go online'}</ThemedText>
            </TouchableOpacity>
          </View>
          {lastLocationAt && isOnline ? <ThemedText style={styles.locationTime}>Location updated {lastLocationAt.toLocaleTimeString()}</ThemedText> : null}
        </View>

        {errorMessage ? <ThemedText style={styles.error}>{errorMessage}</ThemedText> : null}

        <View style={styles.sectionHeader}>
          <ThemedText type="subtitle" style={styles.sectionTitle}>New requests</ThemedText>
          <ThemedText style={styles.count}>{requests.length}</ThemedText>
        </View>
        {!isOnline ? <ThemedText style={styles.empty}>Go online to receive nearby ride and delivery requests.</ThemedText> : requests.length === 0 ? <ThemedText style={styles.empty}>No nearby requests right now.</ThemedText> : requests.map((request) => (
          <View key={`${request.service_type}-${request.id}`} style={styles.requestRow}>
            <View style={styles.requestMain}>
              <View style={styles.chipRow}>
                <View style={[styles.chip, isDelivery(request) && styles.chipDelivery]}>
                  <ThemedText style={[styles.chipText, isDelivery(request) && styles.chipTextDelivery]}>{isDelivery(request) ? 'DELIVERY' : 'RIDE'}</ThemedText>
                </View>
                {request.vehicle_type ? <ThemedText style={styles.muted}>{request.vehicle_type}</ThemedText> : null}
                {isDelivery(request) && request.cargo_weight_kg ? <ThemedText style={styles.muted}>{request.cargo_weight_kg} kg</ThemedText> : null}
              </View>
              <ThemedText type="smallBold">{isDelivery(request) ? request.merchant_name || 'Merchant' : request.customer_name || 'Customer'}</ThemedText>
              {isDelivery(request) && request.dropoff_location ? (
                <ThemedText style={styles.muted}>Drop {request.dropoff_location.latitude.toFixed(4)}, {request.dropoff_location.longitude.toFixed(4)}</ThemedText>
              ) : null}
              <ThemedText style={styles.muted}>{distanceToPickup(request) ?? 'Nearby pickup'}</ThemedText>
              {deliveryLeg(request) ? <ThemedText style={styles.muted}>{deliveryLeg(request)}</ThemedText> : null}
              <ThemedText style={styles.amount}>{deliveryFee(request) ?? `${request.currency} ${request.total_amount}`}</ThemedText>
            </View>
            <View style={styles.requestActions}>
              <TouchableOpacity style={styles.declineButton} onPress={() => void handleRequest(request, false)}><ThemedText style={styles.declineText}>Decline</ThemedText></TouchableOpacity>
              <TouchableOpacity style={styles.acceptButton} onPress={() => void handleRequest(request, true)}><ThemedText style={styles.acceptText}>Accept</ThemedText></TouchableOpacity>
            </View>
          </View>
        ))}

        <View style={styles.sectionHeader}>
          <ThemedText type="subtitle" style={styles.sectionTitle}>Active work</ThemedText>
          <ThemedText style={styles.count}>{tasks.length}</ThemedText>
        </View>
        {primaryTask ? (
          <RouteMap
            pickup={primaryTask.pickup_location}
            dropoff={primaryTask.dropoff_location ?? null}
            driver={driverPosition}
            approachPolyline={approachRoutePolyline}
            tripPolyline={tripRoutePolyline}
          />
        ) : null}
        {tasks.length === 0 ? <ThemedText style={styles.empty}>Accepted rides and deliveries will appear here.</ThemedText> : tasks.map((task) => (
          <View key={`${task.service_type}-${task.id}`} style={styles.taskRow}>
            <View style={styles.chipRow}>
              <View style={[styles.chip, isDelivery(task) && styles.chipDelivery]}>
                <ThemedText style={[styles.chipText, isDelivery(task) && styles.chipTextDelivery]}>{isDelivery(task) ? 'DELIVERY' : 'RIDE'}</ThemedText>
              </View>
              <ThemedText style={styles.statusPill}>{labelFor(task.status)}</ThemedText>
            </View>
            <ThemedText type="smallBold">{isDelivery(task) ? task.merchant_name || 'Merchant' : 'Passenger'}</ThemedText>
            <ThemedText style={styles.muted}>
              {isDelivery(task) ? 'Collect' : 'Pick up'} {task.pickup_location.latitude.toFixed(4)}, {task.pickup_location.longitude.toFixed(4)}
            </ThemedText>
            {task.dropoff_location ? (
              <ThemedText style={styles.muted}>Drop {task.dropoff_location.latitude.toFixed(4)}, {task.dropoff_location.longitude.toFixed(4)}</ThemedText>
            ) : null}
            <ThemedText style={styles.amount}>{deliveryFee(task) ?? `${task.currency} ${task.total_amount}`}</ThemedText>
            <View style={styles.taskActions}>
              {isDelivery(task) && task.status === 'assigned' && task.vendor_ready !== false ? (
                <TouchableOpacity disabled={busy} style={[styles.acceptButton, busy && styles.disabled]} onPress={() => void handleAdvance(task)}><ThemedText style={styles.acceptText}>Take pickup photo</ThemedText></TouchableOpacity>
              ) : null}
              {isDelivery(task) && task.status === 'assigned' && task.vendor_ready === false ? (
                <ThemedText style={styles.waiting}>Waiting for the merchant to mark the basket ready.</ThemedText>
              ) : null}
              {isDelivery(task) && task.status === 'picked_up' ? (
                <ThemedText style={styles.waiting}>Photo sent. Waiting for the merchant to release the order.</ThemedText>
              ) : null}
              {isDelivery(task) && task.status === 'out_for_delivery' ? (
                <TouchableOpacity disabled={busy} style={[styles.acceptButton, busy && styles.disabled]} onPress={() => void handleAdvance(task)}><ThemedText style={styles.acceptText}>Take dropoff photo</ThemedText></TouchableOpacity>
              ) : null}
              {!isDelivery(task) && task.status === 'accepted' ? (
                <TouchableOpacity disabled={busy} style={[styles.acceptButton, busy && styles.disabled]} onPress={() => void handleAdvance(task)}><ThemedText style={styles.acceptText}>Start ride</ThemedText></TouchableOpacity>
              ) : null}
              {!isDelivery(task) && task.status === 'in_transit' ? (
                <TouchableOpacity disabled={busy} style={[styles.acceptButton, busy && styles.disabled]} onPress={() => void handleAdvance(task)}><ThemedText style={styles.acceptText}>Complete</ThemedText></TouchableOpacity>
              ) : null}
              {(isDelivery(task) ? task.status === 'assigned' : task.status === 'accepted') ? (
                <TouchableOpacity disabled={busy} style={[styles.declineButton, busy && styles.disabled]} onPress={() => void handleAbandon(task)}><ThemedText style={styles.declineText}>Release</ThemedText></TouchableOpacity>
              ) : null}
            </View>
          </View>
        ))}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: Spacing.four, paddingBottom: 56, gap: 18 },
  loginWrap: { width: '100%', maxWidth: 460, alignSelf: 'center', flex: 1, justifyContent: 'center', padding: Spacing.four, gap: 14 },
  topBar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  eyebrow: { color: '#147D69', letterSpacing: 1 },
  heading: { fontSize: 28, lineHeight: 34, marginTop: 3 },
  loginTitle: { fontSize: 30, lineHeight: 36, marginTop: 8 },
  muted: { color: '#68736F', fontSize: 13, lineHeight: 19 },
  input: { height: 50, borderWidth: 1, borderRadius: 8, paddingHorizontal: 14, marginTop: 6 },
  primaryButton: { height: 50, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: '#147D69', marginTop: 4 },
  buttonText: { color: '#fff', fontWeight: '700' },
  disabled: { opacity: 0.55 },
  signOut: { color: '#147D69', fontWeight: '600' },
  availability: { borderRadius: 8, borderWidth: 1, borderColor: '#D9E2DE', padding: 16, backgroundColor: '#F4F7F5' },
  availabilityOnline: { borderColor: '#A7D5C9', backgroundColor: '#EEF8F5' },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 11 },
  statusDot: { width: 11, height: 11, borderRadius: 6, backgroundColor: '#9AA6A2' },
  statusDotOnline: { backgroundColor: '#16866F' },
  statusTextWrap: { flex: 1, gap: 3 },
  availabilityButton: { minHeight: 40, paddingHorizontal: 14, alignItems: 'center', justifyContent: 'center', borderRadius: 7, backgroundColor: '#147D69' },
  availabilityButtonText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  offlineButton: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#C6D0CC' },
  offlineButtonText: { color: '#34413C' },
  locationTime: { color: '#62736D', fontSize: 11, marginTop: 10 },
  error: { color: '#B42318', fontSize: 13 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 9, marginTop: 6 },
  sectionTitle: { fontSize: 20, lineHeight: 26 },
  count: { backgroundColor: '#E6EEEA', color: '#31433C', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 12, overflow: 'hidden', fontSize: 12 },
  empty: { color: '#68736F', fontSize: 13, paddingVertical: 12 },
  chipRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chip: { backgroundColor: '#E3EEF9', paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4 },
  chipDelivery: { backgroundColor: '#FBEEDD' },
  chipText: { color: '#23527C', fontSize: 10, letterSpacing: 0.6, fontWeight: '700' },
  chipTextDelivery: { color: '#8A5416' },
  statusPill: { color: '#31433C', fontSize: 11, fontWeight: '600' },
  requestRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: 1, borderColor: '#E2E8E5', paddingVertical: 14 },
  requestMain: { flex: 1, gap: 3 },
  amount: { color: '#263630', fontWeight: '700', marginTop: 3 },
  requestActions: { flexDirection: 'row', gap: 7 },
  acceptButton: { backgroundColor: '#147D69', minWidth: 68, height: 38, justifyContent: 'center', alignItems: 'center', borderRadius: 7, paddingHorizontal: 10 },
  acceptText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  declineButton: { borderWidth: 1, borderColor: '#C7D0CC', minWidth: 68, height: 38, justifyContent: 'center', alignItems: 'center', borderRadius: 7, paddingHorizontal: 10 },
  declineText: { color: '#42504A', fontSize: 12, fontWeight: '600' },
  waiting: { color: '#8A5416', fontSize: 12, fontWeight: '600', paddingVertical: 8 },
  taskRow: { gap: 4, paddingVertical: 13, borderTopWidth: 1, borderColor: '#E2E8E5' },
  taskActions: { flexDirection: 'row', gap: 8, marginTop: 8, flexWrap: 'wrap' },
});
