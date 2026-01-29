import { useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import { useCategories } from '@/hooks/useCategories';
import { Category } from '@/lib/api';
import { Tag, Plus, Pencil, Trash2, Loader2 } from 'lucide-react';

const DEFAULT_COLORS = [
  '#22C55E', // green
  '#3B82F6', // blue
  '#F59E0B', // amber
  '#EF4444', // red
  '#8B5CF6', // violet
  '#EC4899', // pink
  '#14B8A6', // teal
  '#6B7280', // gray
];

const CategoriesSettings = () => {
  const { categories, loading, error, addCategory, editCategory, removeCategory } = useCategories();
  
  // Add/Edit modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [formName, setFormName] = useState('');
  const [formColor, setFormColor] = useState('#22C55E');
  const [saving, setSaving] = useState(false);
  
  // Delete confirmation state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [categoryToDelete, setCategoryToDelete] = useState<Category | null>(null);
  const [deleting, setDeleting] = useState(false);

  const openAddModal = () => {
    setEditingCategory(null);
    setFormName('');
    setFormColor(DEFAULT_COLORS[0]);
    setModalOpen(true);
  };

  const openEditModal = (category: Category) => {
    setEditingCategory(category);
    setFormName(category.name);
    setFormColor(category.color || DEFAULT_COLORS[0]);
    setModalOpen(true);
  };

  const handleSave = async () => {
    const trimmedName = formName.trim();
    
    if (!trimmedName) {
      toast({
        title: 'Name required',
        description: 'Please enter a category name',
        variant: 'destructive',
      });
      return;
    }

    if (trimmedName.length > 40) {
      toast({
        title: 'Name too long',
        description: 'Category name must be 40 characters or less',
        variant: 'destructive',
      });
      return;
    }

    // Validate color format
    const colorRegex = /^#[0-9A-Fa-f]{6}$/;
    const colorToSave = colorRegex.test(formColor) ? formColor : undefined;

    setSaving(true);
    try {
      if (editingCategory) {
        await editCategory(editingCategory.id, trimmedName, colorToSave);
        toast({ title: 'Category updated' });
      } else {
        await addCategory(trimmedName, colorToSave);
        toast({ title: 'Category created' });
      }
      setModalOpen(false);
    } catch (err) {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Could not save category',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteClick = (category: Category) => {
    setCategoryToDelete(category);
    setDeleteDialogOpen(true);
  };

  const handleConfirmDelete = async () => {
    if (!categoryToDelete) return;
    
    setDeleting(true);
    try {
      await removeCategory(categoryToDelete.id);
      toast({ title: 'Category removed' });
      setDeleteDialogOpen(false);
      setCategoryToDelete(null);
    } catch (err) {
      toast({
        title: 'Error',
        description: err instanceof Error ? err.message : 'Could not delete category',
        variant: 'destructive',
      });
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Tag className="h-5 w-5 text-primary" />
            <CardTitle className="text-base font-medium">Categories</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Tag className="h-5 w-5 text-primary" />
            <CardTitle className="text-base font-medium">Categories</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">{error}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Tag className="h-5 w-5 text-primary" />
            <CardTitle className="text-base font-medium">Categories</CardTitle>
          </div>
          <p className="text-sm text-muted-foreground">
            Categories help you organize receipts in Spendify and CSV exports. They are not exported to YNAB.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {categories.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-muted-foreground mb-4">No categories yet</p>
              <Button onClick={openAddModal} variant="outline">
                <Plus className="h-4 w-4 mr-2" />
                Add category
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                {categories.map((category) => (
                  <div
                    key={category.id}
                    className="flex items-center justify-between p-3 rounded-lg border border-border bg-card"
                  >
                    <div className="flex items-center gap-3">
                      <div
                        className="w-3 h-3 rounded-full shrink-0"
                        style={{ backgroundColor: category.color || '#6B7280' }}
                      />
                      <span className="font-medium text-sm">{category.name}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEditModal(category)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => handleDeleteClick(category)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <Button onClick={openAddModal} variant="outline" className="w-full">
                <Plus className="h-4 w-4 mr-2" />
                Add category
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* Add/Edit Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {editingCategory ? 'Edit category' : 'Add category'}
            </DialogTitle>
            <DialogDescription>
              {editingCategory 
                ? 'Update the category name and color.'
                : 'Create a new category for organizing receipts.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="categoryName">Name</Label>
              <Input
                id="categoryName"
                placeholder="e.g. Groceries"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                maxLength={40}
              />
              <p className="text-xs text-muted-foreground">{formName.length}/40 characters</p>
            </div>
            <div className="space-y-2">
              <Label>Color</Label>
              <div className="flex flex-wrap gap-2">
                {DEFAULT_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`w-8 h-8 rounded-full border-2 transition-all ${
                      formColor === color 
                        ? 'border-foreground scale-110' 
                        : 'border-transparent hover:scale-105'
                    }`}
                    style={{ backgroundColor: color }}
                    onClick={() => setFormColor(color)}
                  />
                ))}
              </div>
              <div className="flex items-center gap-2 mt-2">
                <Label htmlFor="customColor" className="text-xs text-muted-foreground">
                  Custom:
                </Label>
                <Input
                  id="customColor"
                  type="text"
                  placeholder="#RRGGBB"
                  value={formColor}
                  onChange={(e) => setFormColor(e.target.value)}
                  className="w-24 h-8 text-xs"
                />
                <input
                  type="color"
                  value={formColor}
                  onChange={(e) => setFormColor(e.target.value)}
                  className="w-8 h-8 rounded cursor-pointer"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              {editingCategory ? 'Save changes' : 'Add category'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete category?</AlertDialogTitle>
            <AlertDialogDescription>
              Receipts using this category will appear as Unassigned.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {deleting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

export default CategoriesSettings;
