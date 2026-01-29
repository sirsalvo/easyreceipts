import { useState, useEffect, useCallback } from 'react';
import { 
  getCategories, 
  createCategory, 
  updateCategory, 
  deleteCategory,
  Category 
} from '@/lib/api';

interface UseCategoriesReturn {
  categories: Category[];
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  addCategory: (name: string, color?: string) => Promise<Category | null>;
  editCategory: (id: string, name: string, color?: string) => Promise<boolean>;
  removeCategory: (id: string) => Promise<boolean>;
  getCategoryById: (id: string | undefined) => Category | undefined;
}

export const useCategories = (): UseCategoriesReturn => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchCategories = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await getCategories();
      setCategories(data);
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

  const addCategory = useCallback(async (name: string, color?: string): Promise<Category | null> => {
    try {
      const newCategory = await createCategory({ name, color });
      setCategories(prev => [...prev, newCategory]);
      return newCategory;
    } catch (err) {
      console.error('Error creating category:', err);
      throw err;
    }
  }, []);

  const editCategory = useCallback(async (id: string, name: string, color?: string): Promise<boolean> => {
    try {
      const updated = await updateCategory(id, { name, color });
      setCategories(prev => prev.map(c => c.id === id ? updated : c));
      return true;
    } catch (err) {
      console.error('Error updating category:', err);
      throw err;
    }
  }, []);

  const removeCategory = useCallback(async (id: string): Promise<boolean> => {
    try {
      await deleteCategory(id);
      setCategories(prev => prev.filter(c => c.id !== id));
      return true;
    } catch (err) {
      console.error('Error deleting category:', err);
      throw err;
    }
  }, []);

  const getCategoryById = useCallback((id: string | undefined): Category | undefined => {
    if (!id) return undefined;
    return categories.find(c => c.id === id);
  }, [categories]);

  return {
    categories,
    loading,
    error,
    refetch: fetchCategories,
    addCategory,
    editCategory,
    removeCategory,
    getCategoryById,
  };
};
