import AsyncStorage from '@react-native-async-storage/async-storage';

export interface PlaceSuggestion {
  place_id: string;
  description: string;
  main_text: string;
  secondary_text: string;
}

const RECENT_SEARCHES_KEY = '@dispatch_recent_searches_v1';
const MAX_RECENT_SEARCHES = 10;

export async function getRecentSearches(): Promise<PlaceSuggestion[]> {
  try {
    const json = await AsyncStorage.getItem(RECENT_SEARCHES_KEY);
    if (!json) return [];
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.warn('Failed to load dispatch recent searches:', error);
    return [];
  }
}

export async function saveRecentSearch(suggestion: PlaceSuggestion): Promise<PlaceSuggestion[]> {
  try {
    const current = await getRecentSearches();
    const filtered = current.filter((item) => item.place_id !== suggestion.place_id);
    const updated = [suggestion, ...filtered].slice(0, MAX_RECENT_SEARCHES);
    await AsyncStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(updated));
    return updated;
  } catch (error) {
    console.warn('Failed to save dispatch recent search:', error);
    return [];
  }
}
