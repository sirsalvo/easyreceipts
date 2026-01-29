import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { toast } from '@/hooks/use-toast';
import { getReceipt, updateReceipt, deleteReceipt, UpdateReceiptPayload } from '@/lib/api';
import { normalizeReceiptResponse, NormalizedReceipt } from '@/lib/receiptNormalizer';
import { getCachedReceipt, updateCachedReceipt } from '@/lib/receiptCache';
import { clearDraftOverride, getDraftOverride, setDraftOverride } from '@/lib/receiptDraftStore';
import { useCategories } from '@/hooks/useCategories';
import { ArrowLeft, Loader2, Save, Check, AlertCircle, Maximize2, X, Trash2 } from 'lucide-react';
import MobileLayout from '@/components/MobileLayout';
import BottomNavigation from '@/components/BottomNavigation';

interface FormData {
  date: string;
  total: string;
  payee: string;
  vat: string;
  vatRate: string;
  categoryId: string;
  notes: string;
}

interface FormErrors {
  date?: string;
  total?: string;
  payee?: string;
  vat?: string;
  vatRate?: string;
}

const VAT_RATES = ['0', '4', '5', '10', '22'];

const UNASSIGNED_VALUE = '__unassigned__';

const Review = () => {
  const navigate = useNavigate();
  const { receiptId } = useParams<{ receiptId: string }>();
  const { categories, loading: categoriesLoading, getCategoryById } = useCategories();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [receipt, setReceipt] = useState<NormalizedReceipt | null>(null);
  const [formData, setFormData] = useState<FormData>({
    date: '',
    total: '',
    payee: '',
    vat: '',
    vatRate: '22',
    categoryId: '',
    notes: '',
  });
  const [errors, setErrors] = useState<FormErrors>({});
  const [showFullImage, setShowFullImage] = useState(false);

  // Check if receipt is a draft (can be deleted)
  const isDraft = receipt && receipt.status !== 'CONFIRMED';

  useEffect(() => {
    const fetchReceipt = async () => {
      if (!receiptId) {
        navigate('/');
        return;
      }

      try {
        // Prefer locally saved draft overrides (most reliable), then list-cache, then API.
        const cachedReceipt = getCachedReceipt(receiptId);
        const localOverride = getDraftOverride(receiptId);

        // Fetch fresh data from API
        const response = await getReceipt(receiptId);
        console.log('API Response:', JSON.stringify(response, null, 2));
        console.log('Cached Receipt:', cachedReceipt);
        console.log('Local Override:', localOverride);

        const apiObj = response as Record<string, unknown>;
        const best = {
          ...(cachedReceipt ?? {}),
          ...(localOverride ?? {}),
        } as Record<string, unknown>;

        const mergedResponse: Record<string, unknown> = {
          ...apiObj,
          // Override with locally known draft data
          ...(best.payee ? { payee: best.payee, merchant: best.payee } : {}),
          ...(best.date ? { date: best.date, receipt_date: best.date } : {}),
          ...(best.total !== undefined && best.total !== null
            ? { total: best.total, total_amount: best.total }
            : {}),
          ...(best.vat !== undefined && best.vat !== null ? { vat: best.vat, vat_amount: best.vat } : {}),
          ...(best.vatRate ? { vatRate: best.vatRate, vat_rate: best.vatRate } : {}),
          ...(best.category ? { category: best.category } : {}),
          ...(best.notes !== undefined ? { notes: best.notes } : {}),
          ...(best.status ? { status: best.status } : {}),
        };

        const normalized = normalizeReceiptResponse(mergedResponse);
        console.log('Normalized:', normalized);
        setReceipt(normalized);

        // Prefill form with extracted/confirmed values
        // Try to get categoryId from the response
        const rawCategoryId = (apiObj.categoryId ?? apiObj.category_id ?? best.categoryId) as string | undefined;
        
        setFormData({
          date: normalized.date || '',
          total: normalized.total !== null ? String(normalized.total).replace('.', ',') : '',
          payee: normalized.payee || '',
          vat: normalized.vat !== null ? String(normalized.vat).replace('.', ',') : '',
          vatRate: normalized.vatRate || '22',
          categoryId: rawCategoryId || '',
          notes: normalized.notes || '',
        });
      } catch (error) {
        toast({
          title: 'Error loading receipt',
          description: error instanceof Error ? error.message : 'An error occurred',
          variant: 'destructive',
        });
        navigate('/');
      } finally {
        setLoading(false);
      }
    };

    fetchReceipt();
  }, [receiptId, navigate]);

  const validateForm = (): boolean => {
    const newErrors: FormErrors = {};

    // Validate using FORM STATE
    if (!formData.date.trim()) {
      newErrors.date = 'Date is required';
    }

    const totalNum = parseFloat(formData.total.replace(',', '.'));
    if (formData.total.trim() === '' || isNaN(totalNum)) {
      newErrors.total = 'Valid total is required';
    }

    if (!formData.payee.trim()) {
      newErrors.payee = 'Payee is required';
    }

    const vatNum = parseFloat(formData.vat.replace(',', '.'));
    if (formData.vat.trim() === '' || isNaN(vatNum)) {
      newErrors.vat = 'Valid VAT amount is required';
    }

    if (!formData.vatRate) {
      newErrors.vatRate = 'VAT rate is required';
    }

    // Category is optional - no validation needed

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleInputChange = (field: keyof FormData, value: string) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    // Clear error when user starts typing
    if (errors[field as keyof FormErrors]) {
      setErrors((prev) => ({ ...prev, [field]: undefined }));
    }
  };

  const handleSubmit = async (status: 'DRAFT' | 'CONFIRMED') => {
    if (!validateForm()) {
      toast({
        title: 'Validation Error',
        description: 'Please fix the errors below',
        variant: 'destructive',
      });
      return;
    }

    if (!receiptId) return;

    setSaving(true);

    try {
      const payload: UpdateReceiptPayload = {
        status,
        payee: formData.payee.trim(),
        date: formData.date,
        total: parseFloat(formData.total.replace(',', '.')),
        vat: parseFloat(formData.vat.replace(',', '.')),
        vatRate: formData.vatRate,
        categoryId: formData.categoryId || null,
        notes: formData.notes.trim(),
      };

      await updateReceipt(receiptId, payload);

      // Persist local override so reopening from list shows the same values
      setDraftOverride(receiptId, payload);

      // Update in-memory cache (used by Review merge)
      updateCachedReceipt(receiptId, {
        payee: payload.payee,
        total: payload.total,
        date: payload.date,
        vat: payload.vat,
        vatRate: payload.vatRate,
        categoryId: payload.categoryId,
        notes: payload.notes,
        status: payload.status,
      });

      if (status === 'CONFIRMED') {
        // Confirmed receipts shouldn't keep draft overrides around
        clearDraftOverride(receiptId);
      }

      toast({
        title: status === 'CONFIRMED' ? 'Receipt Confirmed' : 'Draft Saved',
        description:
          status === 'CONFIRMED'
            ? 'Your receipt has been confirmed successfully'
            : 'Your changes have been saved as a draft',
      });

      if (status === 'CONFIRMED') {
        navigate(`/confirmation/${receiptId}`);
      } else {
        navigate('/receipts');
      }
    } catch (error) {
      toast({
        title: 'Error saving receipt',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!receiptId) return;

    setDeleting(true);
    try {
      await deleteReceipt(receiptId);
      
      // Clear local caches
      clearDraftOverride(receiptId);

      toast({
        title: 'Draft deleted',
        description: 'The receipt draft has been deleted.',
      });

      navigate('/receipts');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'An error occurred';
      
      // Handle 409 Conflict - confirmed receipt cannot be deleted
      if (errorMessage.includes('409') || errorMessage.toLowerCase().includes('conflict')) {
        toast({
          title: 'Cannot delete',
          description: 'Cannot delete a confirmed receipt.',
          variant: 'destructive',
        });
      } else {
        toast({
          title: 'Error deleting receipt',
          description: errorMessage,
          variant: 'destructive',
        });
      }
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <MobileLayout>
        <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
          <p className="text-muted-foreground">Loading receipt...</p>
        </div>
      </MobileLayout>
    );
  }

  const hasErrors = Object.keys(errors).length > 0;

  return (
    <MobileLayout>
      <div className="p-4 pt-8 space-y-4 pb-32">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate('/receipts')}
            className="shrink-0"
          >
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <h1 className="text-xl font-semibold">Review Receipt</h1>
        </div>

        {hasErrors && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>Please fix the errors below</AlertDescription>
          </Alert>
        )}

        {/* Receipt Image */}
        {receipt?.imageUrl && (
          <Card>
            <CardContent className="p-4">
              <div className="relative">
                <img
                  src={receipt.imageUrl}
                  alt="Receipt"
                  className="w-full h-auto max-h-48 object-contain rounded-lg bg-muted/30 cursor-pointer"
                  onClick={() => setShowFullImage(true)}
                />
                <Button
                  size="icon"
                  variant="secondary"
                  className="absolute top-2 right-2"
                  onClick={() => setShowFullImage(true)}
                >
                  <Maximize2 className="h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Form Fields */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Receipt Details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Date */}
            <div className="space-y-2">
              <Label htmlFor="date" className={errors.date ? 'text-destructive' : ''}>
                Date *
              </Label>
              <Input
                id="date"
                type="date"
                value={formData.date}
                onChange={(e) => handleInputChange('date', e.target.value)}
                className={errors.date ? 'border-destructive' : ''}
              />
              {errors.date && (
                <p className="text-xs text-destructive">{errors.date}</p>
              )}
            </div>

            {/* Payee */}
            <div className="space-y-2">
              <Label htmlFor="payee" className={errors.payee ? 'text-destructive' : ''}>
                Payee *
              </Label>
              <Input
                id="payee"
                placeholder="Store or vendor name"
                value={formData.payee}
                onChange={(e) => handleInputChange('payee', e.target.value)}
                className={errors.payee ? 'border-destructive' : ''}
              />
              {errors.payee && (
                <p className="text-xs text-destructive">{errors.payee}</p>
              )}
            </div>

            {/* Total */}
            <div className="space-y-2">
              <Label htmlFor="total" className={errors.total ? 'text-destructive' : ''}>
                Total *
              </Label>
              <Input
                id="total"
                type="text"
                inputMode="decimal"
                placeholder="0,00"
                value={formData.total}
                onChange={(e) => handleInputChange('total', e.target.value)}
                className={errors.total ? 'border-destructive' : ''}
              />
              {errors.total && (
                <p className="text-xs text-destructive">{errors.total}</p>
              )}
            </div>

            {/* VAT Amount */}
            <div className="space-y-2">
              <Label htmlFor="vat" className={errors.vat ? 'text-destructive' : ''}>
                VAT Amount *
              </Label>
              <Input
                id="vat"
                type="text"
                inputMode="decimal"
                placeholder="0,00"
                value={formData.vat}
                onChange={(e) => handleInputChange('vat', e.target.value)}
                className={errors.vat ? 'border-destructive' : ''}
              />
              {errors.vat && (
                <p className="text-xs text-destructive">{errors.vat}</p>
              )}
            </div>

            {/* VAT Rate */}
            <div className="space-y-2">
              <Label className={errors.vatRate ? 'text-destructive' : ''}>
                VAT Rate *
              </Label>
              <Select
                value={formData.vatRate}
                onValueChange={(value) => handleInputChange('vatRate', value)}
              >
                <SelectTrigger className={errors.vatRate ? 'border-destructive' : ''}>
                  <SelectValue placeholder="Select VAT rate" />
                </SelectTrigger>
                <SelectContent>
                  {VAT_RATES.map((rate) => (
                    <SelectItem key={rate} value={rate}>
                      {rate}%
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {errors.vatRate && (
                <p className="text-xs text-destructive">{errors.vatRate}</p>
              )}
            </div>

            {/* Category */}
            <div className="space-y-2">
              <Label>Category</Label>
              <Select
                value={formData.categoryId || UNASSIGNED_VALUE}
                onValueChange={(value) => handleInputChange('categoryId', value === UNASSIGNED_VALUE ? '' : value)}
                disabled={categoriesLoading}
              >
                <SelectTrigger>
                  <SelectValue placeholder={categoriesLoading ? 'Loading...' : 'Select category'}>
                    {formData.categoryId 
                      ? getCategoryById(formData.categoryId)?.name || 'Unassigned'
                      : 'Unassigned'}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
                  {categories.map((cat) => (
                    <SelectItem key={cat.id} value={cat.id}>
                      <div className="flex items-center gap-2">
                        {cat.color && (
                          <div
                            className="w-2.5 h-2.5 rounded-full shrink-0"
                            style={{ backgroundColor: cat.color }}
                          />
                        )}
                        <span>{cat.name}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Categories are internal only and never exported to YNAB.
              </p>
            </div>

            {/* Notes */}
            <div className="space-y-2">
              <Label htmlFor="notes">Notes (optional)</Label>
              <Textarea
                id="notes"
                placeholder="Add any additional notes..."
                value={formData.notes}
                onChange={(e) => handleInputChange('notes', e.target.value)}
                rows={3}
              />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Fixed Bottom Actions */}
      <div className="fixed bottom-0 left-0 right-0 p-4 pb-6 bg-background border-t border-border z-50">
        <div className="max-w-lg mx-auto space-y-3">
          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => handleSubmit('DRAFT')}
              disabled={saving || deleting}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Draft
            </Button>
            <Button
              className="flex-1"
              onClick={() => handleSubmit('CONFIRMED')}
              disabled={saving || deleting}
            >
              {saving ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Check className="h-4 w-4 mr-2" />
              )}
              Confirm
            </Button>
          </div>
          
          {/* Delete Draft Button - only shown for drafts */}
          {isDraft && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="destructive"
                  className="w-full"
                  disabled={saving || deleting}
                >
                  {deleting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4 mr-2" />
                  )}
                  Delete Draft
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete Draft</AlertDialogTitle>
                  <AlertDialogDescription>
                    Are you sure you want to delete this draft receipt? This action cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={handleDelete}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>
      <BottomNavigation />

      {/* Fullscreen Image Modal */}
      {showFullImage && receipt?.imageUrl && (
        <div
          className="fixed inset-0 z-50 bg-background/95 flex items-center justify-center p-4"
          onClick={() => setShowFullImage(false)}
        >
          <Button
            size="icon"
            variant="ghost"
            className="absolute top-14 right-4"
            onClick={() => setShowFullImage(false)}
          >
            <X className="h-6 w-6" />
          </Button>
          <img
            src={receipt.imageUrl}
            alt="Receipt full view"
            className="max-w-full max-h-full object-contain"
          />
        </div>
      )}
    </MobileLayout>
  );
};

export default Review;
