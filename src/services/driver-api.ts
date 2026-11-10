import * as Location from 'expo-location';
import * as ImagePicker from 'expo-image-picker';
import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';
import { getAuth, signInWithEmailAndPassword } from 'firebase/auth';
import { getApps, initializeApp } from 'firebase/app';
import { getDownloadURL, getStorage, ref as storageRef, uploadBytes } from 'firebase/storage';

export type DriverSession = {
  token: string;
  userId: string;
  email: string;
  roles: string[];
};

export type DriverRequest = {
  id: string;
  status: string;
  total_amount: string;
  currency: string;
  customer_name: string;
  pickup_location: { latitude: number; longitude: number };
  dropoff_location?: { latitude: number; longitude: number };
  distance_m?: number;
  service_type?: 'ride' | 'delivery';
  /** Tier key the rider asked for (rides) or dispatch matched the load to (deliveries). */
  vehicle_type?: string;
  /** Delivery-only: the merchant the parcel is collected from. */
  merchant_name?: string;
  /** Delivery-only: the business the sub-order belongs to. */
  merchant_id?: string;
  /** Delivery-only: food | grocery | liquor. */
  service?: string;
  /** Delivery-only: the load dispatch sized the courier for. */
  cargo_weight_kg?: number;
  /** Delivery-only: the server-computed courier fee and the leg it priced. */
  fare_amount?: string;
  fare_currency?: string;
  distance_km?: number;
  duration_minutes?: number;
  /** The assigned driver's estimated minutes to pickup (or dropoff in transit). */
  eta_minutes?: number;
  /** Delivery-only: false while the merchant has not packed the basket. */
  vendor_ready?: boolean;
  vendor_ready_at?: string;
  /** RFC 3339 timestamps, empty until the step happens. */
  accepted_at?: string;
  started_at?: string;
  picked_up_at?: string;
  out_for_delivery_at?: string;
  completed_at?: string;
  delivered_at?: string;
  customer_confirmed_at?: string;
  /** Rides only: when the offer stops being available. */
  expires_at?: string;
  created_at?: string;
};

// Extracted services (auth, dispatch) are reached through the gateway, which
// fronts them over gRPC.
const gatewayRoot = (process.env.EXPO_PUBLIC_GATEWAY_URL || 'http://10.0.2.2:9010/api/v1/gateway').replace(/\/+$/, '');
const firebaseApp = getApps()[0] ?? initializeApp({
  apiKey: process.env.EXPO_PUBLIC_FIREBASE_API_KEY || 'AIzaSyDummyKeyForDevelopment123456789',
  authDomain: process.env.EXPO_PUBLIC_FIREBASE_AUTH_DOMAIN || 'ehub-dispatch.firebaseapp.com',
  projectId: process.env.EXPO_PUBLIC_FIREBASE_PROJECT_ID || 'ehub-dispatch',
  storageBucket: process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET || 'ehub-dispatch.appspot.com',
  messagingSenderId: process.env.EXPO_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || '123456789012',
  appId: process.env.EXPO_PUBLIC_FIREBASE_APP_ID || '1:123456789012:web:abcdef1234567890',
});
// The gateway session JWT is persisted in SecureStore and restored separately, so
// Firebase Auth only needs to live for the sign-in exchange. Keeping it
// in-memory avoids the browser-vs-React-Native persistence typing split in
// firebase/auth v12 while preserving the driver's actual session.
const firebaseAuth = getAuth(firebaseApp);
const SESSION_KEY = 'dispatch_driver_session';

async function request<T>(url: string, token: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `Request failed (${response.status})`);
  return body as T;
}

export async function signInDriver(email: string, password: string): Promise<DriverSession> {
  const credential = await signInWithEmailAndPassword(firebaseAuth, email.trim(), password);
  const firebaseToken = await credential.user.getIdToken();
  const response = await fetch(`${gatewayRoot}/auth/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id_token: firebaseToken, include_session_token: true }),
  });
  const user = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(user?.error || 'Could not start your driver session.');
  if (!Array.isArray(user.roles) || !user.roles.includes('driver')) {
    throw new Error('This account does not have the driver role.');
  }
  if (!user.session_token || !user.user_id) throw new Error('Auth service did not return a driver session.');
  const session: DriverSession = { token: user.session_token, userId: user.user_id, email: user.email, roles: user.roles };
  await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(session));
  return session;
}

export async function loadDriverSession(): Promise<DriverSession | null> {
  const stored = await SecureStore.getItemAsync(SESSION_KEY);
  if (!stored) return null;
  try {
    const session = JSON.parse(stored) as DriverSession;
    return session.token && session.userId && session.roles.includes('driver') ? session : null;
  } catch {
    await SecureStore.deleteItemAsync(SESSION_KEY);
    return null;
  }
}

export async function signOutDriver() {
  await SecureStore.deleteItemAsync(SESSION_KEY);
  await firebaseAuth.signOut();
}

export async function setDriverAvailability(token: string, status: 'online' | 'offline') {
  return request<{ status: string }>(`${gatewayRoot}/dispatch/driver/status`, token, {
    method: 'PUT', body: JSON.stringify({ status }),
  });
}

/**
 * Publish the driver's current position. Dispatch is the authoritative store
 * for both rides and deliveries, and reachability depends on a fresh position,
 * so the write is not best-effort: if it fails, the driver should be told.
 */
export async function updateDriverLocation(token: string, location: Pick<Location.LocationObjectCoords, 'latitude' | 'longitude'>) {
  return request<{ status: string }>(`${gatewayRoot}/dispatch/driver/location`, token, {
    method: 'PUT', body: JSON.stringify({ lat: location.latitude, lng: location.longitude }),
  });
}

export type DriverEvent = {
  type: string;
  at: string;
  data: unknown;
};

/**
 * Subscribe to the gateway's server-sent driver stream. The stream carries
 * `ride_offer` and `delivery_offer` events; the polled feed remains the
 * recovery path when the stream is unavailable.
 *
 * The gateway also accepts `?token=` for browser EventSource clients, but this
 * native client sends the bearer header so the session token never enters the
 * URL or the gateway access log.
 */
export async function subscribeToDriverEvents(
  token: string,
  onEvent: (event: DriverEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await expoFetch(`${gatewayRoot}/dispatch/driver/stream`, {
    headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`Driver event stream failed (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const payload = frame
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('\n');
      if (payload) {
        try {
          onEvent(JSON.parse(payload) as DriverEvent);
        } catch {
          // A malformed frame must not tear down the stream; polling recovers.
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
}

export type DispatchRoute = {
  distance_meters: number;
  duration_seconds: number;
  /** Encoded polyline (precision 5) to decode on-device. */
  polyline: string;
};

/**
 * Road path between two points, served by the dispatch service's OSRM router.
 * Used for the driver -> pickup approach and the active pickup -> dropoff leg.
 */
export async function getRoute(
  token: string,
  from: Pick<Location.LocationObjectCoords, 'latitude' | 'longitude'>,
  to: Pick<Location.LocationObjectCoords, 'latitude' | 'longitude'>,
): Promise<DispatchRoute | null> {
  const query = [
    `from_lat=${encodeURIComponent(from.latitude)}`,
    `from_lng=${encodeURIComponent(from.longitude)}`,
    `to_lat=${encodeURIComponent(to.latitude)}`,
    `to_lng=${encodeURIComponent(to.longitude)}`,
  ].join('&');
  const data = await request<{ route?: DispatchRoute }>(`${gatewayRoot}/dispatch/route?${query}`, token);
  return data.route ?? null;
}

function toRideRequest(trip: any): DriverRequest {
  return {
    id: trip.id,
    status: trip.status ?? 'requested',
    total_amount: String(trip.total_amount ?? ''),
    currency: trip.currency ?? 'KES',
    customer_name: 'Passenger',
    pickup_location: trip.pickup_location ?? { latitude: 0, longitude: 0 },
    dropoff_location: trip.dropoff_location,
    // The ride feed reports the distance to the pickup; active tasks do not.
    distance_m: typeof trip.distance_meters === 'number' ? trip.distance_meters : undefined,
    service_type: 'ride',
    vehicle_type: trip.vehicle_type || undefined,
    distance_km: typeof trip.distance_km === 'number' ? trip.distance_km : undefined,
    duration_minutes: typeof trip.duration_minutes === 'number' ? trip.duration_minutes : undefined,
    eta_minutes: typeof trip.eta_minutes === 'number' ? trip.eta_minutes : undefined,
    expires_at: trip.expires_at || undefined,
    created_at: trip.created_at || undefined,
    accepted_at: trip.accepted_at || undefined,
    started_at: trip.started_at || undefined,
    completed_at: trip.completed_at || undefined,
  };
}

function toDeliveryRequest(delivery: any): DriverRequest {
  return {
    id: delivery.id,
    status: delivery.status ?? 'requested',
    total_amount: String(delivery.total_amount ?? ''),
    currency: delivery.currency ?? 'KES',
    customer_name: 'Customer',
    pickup_location: delivery.pickup_location ?? { latitude: 0, longitude: 0 },
    dropoff_location: delivery.dropoff_location,
    // The courier feed reports the distance to the merchant; active tasks do not.
    distance_m: typeof delivery.distance_meters === 'number' ? delivery.distance_meters : undefined,
    service_type: 'delivery',
    vehicle_type: delivery.vehicle_type || undefined,
    merchant_name: delivery.merchant_name || undefined,
    merchant_id: delivery.merchant_id || undefined,
    service: delivery.service || undefined,
    cargo_weight_kg: typeof delivery.cargo_weight_kg === 'number' ? delivery.cargo_weight_kg : undefined,
    fare_amount: delivery.fare_amount || undefined,
    fare_currency: delivery.fare_currency || undefined,
    distance_km: typeof delivery.distance_km === 'number' ? delivery.distance_km : undefined,
    duration_minutes: typeof delivery.duration_minutes === 'number' ? delivery.duration_minutes : undefined,
    vendor_ready: typeof delivery.vendor_ready === 'boolean' ? delivery.vendor_ready : undefined,
    vendor_ready_at: delivery.vendor_ready_at || undefined,
    created_at: delivery.created_at || undefined,
    accepted_at: delivery.accepted_at || undefined,
    picked_up_at: delivery.picked_up_at || undefined,
    out_for_delivery_at: delivery.out_for_delivery_at || undefined,
    delivered_at: delivery.delivered_at || undefined,
    completed_at: delivery.completed_at || undefined,
    customer_confirmed_at: delivery.customer_confirmed_at || undefined,
  };
}

/**
 * Open ride requests near the driver, served by the extracted dispatch service.
 * The dispatch service already filters by the driver's vehicle class/capacity,
 * so a 4-seat car never sees an XL request.
 */
export async function getRideRequests(token: string): Promise<DriverRequest[]> {
  // The gateway renders protojson with UseProtoNames, so the repeated `trips`
  // field is emitted as `requests`. Reading `trips` silently returned nothing.
  const data = await request<{ requests?: any[] }>(`${gatewayRoot}/dispatch/ride-requests`, token);
  return (data.requests || []).map(toRideRequest);
}

/**
 * Open delivery requests near the driver, served by the extracted dispatch
 * service. Deliveries are one vendor sub-order each (food, grocery, liquor), and
 * dispatch only offers the driver parcels their vehicle class can carry.
 */
export async function getDeliveryRequests(token: string): Promise<DriverRequest[]> {
  const data = await request<{ deliveries?: any[] }>(`${gatewayRoot}/dispatch/delivery-requests`, token);
  return (data.deliveries || []).map(toDeliveryRequest);
}

export async function getRequests(token: string) {
  const [rides, deliveries] = await Promise.all([
    getRideRequests(token).catch(() => [] as DriverRequest[]),
    getDeliveryRequests(token).catch(() => [] as DriverRequest[]),
  ]);
  return [...rides, ...deliveries];
}

/** The courier's finished deliveries, newest first. */
export async function getDeliveryHistory(token: string, limit = 20): Promise<DriverRequest[]> {
  const data = await request<{ deliveries?: any[] }>(`${gatewayRoot}/dispatch/delivery-history?limit=${limit}`, token);
  return (data.deliveries || []).map(toDeliveryRequest);
}

/** The driver's completed rides, newest first. */
export async function getRideHistory(token: string, limit = 20): Promise<DriverRequest[]> {
  const data = await request<{ trips?: any[] }>(`${gatewayRoot}/dispatch/ride-history?limit=${limit}`, token);
  return (data.trips || []).map(toRideRequest);
}

export async function acceptRideRequest(token: string, tripId: string) {
  return request(`${gatewayRoot}/dispatch/trips/${tripId}/accept`, token, { method: 'POST' });
}

export async function startRide(token: string, tripId: string) {
  return request(`${gatewayRoot}/dispatch/trips/${tripId}/start`, token, { method: 'POST' });
}

export async function completeRide(token: string, tripId: string) {
  return request(`${gatewayRoot}/dispatch/trips/${tripId}/complete`, token, { method: 'POST' });
}

/** Record that the driver passed on a ride offer. */
export async function declineRide(token: string, tripId: string, reason?: string) {
  await request<Record<string, never>>(
    `${gatewayRoot}/dispatch/trips/${tripId}/decline`,
    token,
    { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
  );
  return { declined: true };
}

/** Withdraw an accepted ride the driver can no longer take. */
export async function cancelRide(token: string, tripId: string, reason?: string) {
  return request(`${gatewayRoot}/dispatch/trips/${tripId}/cancel`, token, {
    method: 'POST',
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

export async function acceptDelivery(token: string, deliveryId: string) {
  return request(`${gatewayRoot}/dispatch/deliveries/${deliveryId}/accept`, token, { method: 'POST' });
}

/** Mark an accepted delivery collected from the merchant. The photo is the
 * evidence the merchant verifies before releasing the parcel. */
export async function pickupDelivery(token: string, deliveryId: string, photoUrl: string, notes?: string) {
  return request(`${gatewayRoot}/dispatch/deliveries/${deliveryId}/pickup`, token, {
    method: 'POST',
    body: JSON.stringify({ photo_url: photoUrl, notes: notes || '' }),
  });
}

/** Mark a released delivery handed to the customer. The dropoff photo is the
 * evidence that soft-completes the order; the customer can confirm later. */
export async function completeDelivery(token: string, deliveryId: string, photoUrl: string, notes?: string) {
  return request(`${gatewayRoot}/dispatch/deliveries/${deliveryId}/complete`, token, {
    method: 'POST',
    body: JSON.stringify({ photo_url: photoUrl, notes: notes || '' }),
  });
}

/** Withdraw a delivery the driver can no longer take. */
export async function cancelDelivery(token: string, deliveryId: string) {
  return request(`${gatewayRoot}/dispatch/deliveries/${deliveryId}/cancel`, token, { method: 'POST' });
}

export async function getActiveTasks(token: string) {
  const data = await request<{ tasks?: DriverRequest[] }>(`${gatewayRoot}/dispatch/driver/tasks`, token);
  return (data.tasks ?? []).map((task): DriverRequest => ({
    ...task,
    // The gateway names the ride's tier; a delivery task carries no tier, so the
    // console falls back to the load it was matched for.
    service_type: task.service_type === 'delivery' ? 'delivery' : 'ride',
  }));
}

/**
 * Record that the courier passed on a delivery. The server keeps the offer open
 * to other couriers and hides it from this one's feed; the console also hides it
 * optimistically so the card disappears immediately.
 */
export async function declineDelivery(token: string, deliveryId: string, reason?: string) {
  await request<Record<string, never>>(
    `${gatewayRoot}/dispatch/deliveries/${deliveryId}/decline`,
    token,
    { method: 'POST', body: JSON.stringify(reason ? { reason } : {}) },
  );
  return { declined: true };
}

/**
 * Accept a request, or pass on it. Declining a ride is still local (rides have
 * no decline endpoint and simply expire out of the feed); declining a delivery
 * is recorded so it is not offered to the same courier again.
 */
export async function respondToRequest(token: string, driverRequest: DriverRequest, accept: boolean) {
  if (!accept) {
    if (driverRequest.service_type === 'delivery') {
      return declineDelivery(token, driverRequest.id);
    }
    return declineRide(token, driverRequest.id);
  }
  if (driverRequest.service_type === 'ride') {
    return acceptRideRequest(token, driverRequest.id);
  }
  return acceptDelivery(token, driverRequest.id);
}

/**
 * Take a handoff photo and upload it to object storage, returning the URL the
 * dispatch service stores as proof. Returns null when the driver cancels the
 * camera, so the caller can leave the job untouched.
 *
 * The proof is a URL, not a binary: dispatch only accepts an http(s) reference.
 * The photo is uploaded under the signed-in driver and job, which is what the
 * storage rules should key on.
 */
export async function captureProofPhoto(
  userId: string,
  jobId: string,
  kind: 'pickup' | 'dropoff',
): Promise<string | null> {
  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Allow camera access to photograph the order before handoff.');
  }
  const result = await ImagePicker.launchCameraAsync({
    mediaTypes: ['images'],
    allowsEditing: false,
    quality: 0.6,
    cameraType: ImagePicker.CameraType.back,
  });
  if (result.canceled) return null;

  const asset = result.assets[0];
  if (!process.env.EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET) {
    throw new Error('Photo storage is not configured (EXPO_PUBLIC_FIREBASE_STORAGE_BUCKET).');
  }
  const extension = (asset.fileName?.split('.').pop() || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const object = storageRef(
    getStorage(firebaseApp),
    `dispatch-proofs/${userId}/${jobId}/${kind}-${Date.now()}.${extension}`,
  );
  const blob = await readPhotoBlob(asset.uri);
  await uploadBytes(object, blob, {
    contentType: asset.mimeType || 'image/jpeg',
    cacheControl: 'private,max-age=31536000',
  });
  return getDownloadURL(object);
}

/** React Native fetch does not always produce a usable Blob for Storage; XHR
 * does, and is what the Expo Firebase upload example uses. */
function readPhotoBlob(uri: string): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.onload = () => resolve(request.response);
    request.onerror = () => reject(new Error('Could not read the captured photo.'));
    request.responseType = 'blob';
    request.open('GET', uri, true);
    request.send(null);
  });
}

export { Location };
