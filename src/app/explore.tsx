import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, View, useColorScheme } from 'react-native';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Colors, Spacing } from '@/constants/theme';
import { DriverRequest, getDeliveryHistory, getRideHistory, loadDriverSession } from '@/services/driver-api';

const STATUS_LABELS: Record<string, string> = {
  delivered: 'Delivered',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

function labelFor(status: string) {
  return STATUS_LABELS[status] ?? status.replace(/_/g, ' ');
}

/** The most recent timestamp a finished job carries. */
function recordTime(request: DriverRequest) {
  return request.delivered_at || request.completed_at || request.picked_up_at || request.created_at || '';
}

function formatWhen(request: DriverRequest) {
  const stamp = recordTime(request);
  if (!stamp) return '';
  const parsed = new Date(stamp);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toLocaleString();
}

/**
 * The driver's finished work, newest first. Deliveries and rides are kept in
 * dispatch's own records, so this survives the app being closed and re-signed-in
 * on another device.
 */
export default function HistoryScreen() {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme === 'dark' ? 'dark' : 'light'];
  const [records, setRecords] = useState<DriverRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const session = await loadDriverSession();
      setError('');
      if (!session) {
        setRecords([]);
        return;
      }
      const [deliveries, rides] = await Promise.all([
        getDeliveryHistory(session.token).catch(() => [] as DriverRequest[]),
        getRideHistory(session.token).catch(() => [] as DriverRequest[]),
      ]);
      setRecords(
        [...deliveries, ...rides]
          .sort((left, right) => recordTime(right).localeCompare(recordTime(left)))
          .slice(0, 50),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your history.');
    } finally {
      setLoading(false);
    }
  }, []);

  // Kick off the initial load. Wrapping it in an async function keeps the
  // resulting state updates off the effect's synchronous render path.
  useEffect(() => {
    const load = async () => {
      await refresh();
    };
    void load();
  }, [refresh]);

  return (
    <ThemedView style={styles.page}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={() => { setLoading(true); void refresh(); }} />}
      >
        <ThemedText type="smallBold" style={styles.eyebrow}>DRIVER ACCOUNT</ThemedText>
        <ThemedText type="subtitle" style={styles.title}>History</ThemedText>

        {error ? <ThemedText style={styles.error}>{error}</ThemedText> : null}

        {loading ? (
          <ActivityIndicator color="#147D69" />
        ) : records.length === 0 ? (
          <ThemedText style={styles.empty}>Finished rides and deliveries will appear here.</ThemedText>
        ) : records.map((record) => (
          <View key={`${record.service_type}-${record.id}`} style={[styles.row, { borderColor: colors.backgroundSelected }]}>
            <View style={styles.rowMain}>
              <ThemedText type="smallBold" style={styles.kind}>
                {record.service_type === 'delivery' ? 'DELIVERY' : 'RIDE'}
              </ThemedText>
              <ThemedText type="smallBold">
                {record.service_type === 'delivery' ? record.merchant_name || 'Merchant' : record.customer_name || 'Passenger'}
              </ThemedText>
              <ThemedText style={styles.when}>{formatWhen(record)}</ThemedText>
            </View>
            <View style={styles.rowRight}>
              <ThemedText style={styles.amount}>{record.currency} {record.total_amount}</ThemedText>
              <ThemedText style={styles.status}>{labelFor(record.status)}</ThemedText>
            </View>
          </View>
        ))}
      </ScrollView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  content: { width: '100%', maxWidth: 760, alignSelf: 'center', padding: Spacing.four, paddingBottom: 48, gap: 12 },
  eyebrow: { color: '#147D69', letterSpacing: 1 },
  title: { fontSize: 28, lineHeight: 34, marginBottom: 6 },
  error: { color: '#B42318', fontSize: 13 },
  empty: { color: '#68736F', fontSize: 14, paddingVertical: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, borderTopWidth: 1, paddingVertical: 13 },
  rowMain: { flex: 1, gap: 2 },
  kind: { color: '#147D69', fontSize: 10, letterSpacing: 0.8 },
  when: { color: '#68736F', fontSize: 12 },
  rowRight: { alignItems: 'flex-end', gap: 3 },
  amount: { color: '#263630', fontWeight: '700' },
  status: { color: '#68736F', fontSize: 12 },
});
