import { useState, useEffect, useCallback } from 'react';
import { getCategories, saveCategories } from '@/lib/api';

interface UseCategoriesReturn {
  categories: string[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  addCategory: (name: string) => Promise<boolean>;
  editCategory: (oldName: string, newName: string) => Promise<boolean>;
  removeCategory: (name: string) => Promise<boolean>;
}

export const useCategories = (): UseCategoriesReturn => {
  const [categories, setCategories] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCategories = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getCategories();
      // Filter out empty strings
      setCategories(data.filter(Boolean));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Provide a user-friendly message for common errors
      if (message.includes('Not Found') || message.includes('404')) {
        setError('Categories feature is not available. The API endpoint may not be deployed yet.');
      } else {
        setError(message || 'Failed to load categories');
      }
      console.error('Error fetching categories:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  const addCategory = useCallback(async (name: string): Promise<boolean> => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    
    // Check for duplicates
    if (categories.includes(trimmed)) {
      throw new Error('Category already exists');
    }
    
    try {
      const updated = [...categories, trimmed];
      await saveCategories(updated);
      setCategories(updated);
      return true;
    } catch (err) {
      console.error('Error adding category:', err);
      throw err;
    }
  }, [categories]);

  const editCategory = useCallback(async (oldName: string, newName: string): Promise<boolean> => {
    const trimmed = newName.trim();
    if (!trimmed) return false;
    
    // Check for duplicates (if renaming to different name)
    if (oldName !== trimmed && categories.includes(trimmed)) {
      throw new Error('Category already exists');
    }
    
    try {
      const updated = categories.map(c => c === oldName ? trimmed : c);
      await saveCategories(updated);
      setCategories(updated);
      return true;
    } catch (err) {
      console.error('Error editing category:', err);
      throw err;
    }
  }, [categories]);

  const removeCategory = useCallback(async (name: string): Promise<boolean> => {
    try {
      const updated = categories.filter(c => c !== name);
      await saveCategories(updated);
      setCategories(updated);
      return true;
    } catch (err) {
      console.error('Error removing category:', err);
      throw err;
    }
  }, [categories]);

  return {
    categories,
    loading,
    error,
    refetch: fetchCategories,
    addCategory,
    editCategory,
    removeCategory,
  };
};