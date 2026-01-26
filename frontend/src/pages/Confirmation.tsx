import { useState, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { getReceipt, updateReceipt } from '@/lib/api';
import { normalizeReceiptResponse, NormalizedReceipt } from '@/lib/receiptNormalizer';
import { getYNABConfig, exportToYNAB } from '@/lib/ynab';
import { formatCurrency } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { useCategories } from '@/hooks/useCategories';
import { 
  CheckCircle2, 
  Plus, 
  FileText, 
  Download,
  Calendar,
  Store,
  Receipt,
  Loader2,
  Maximize2,
  X
} from 'lucide-react';
import MobileLayout from '@/components/MobileLayout';
import BottomNavigation from '@/components/BottomNavigation';

const Confirmation = () => {
  const navigate = useNavigate();
  const { receiptId } = useParams<{ receiptId: string }>();
  const { getCategoryById } = useCategories();
  const [loading, setLoading] = useState(true);
  const [receipt, setReceipt] = useState<NormalizedReceipt | null>(null);
  const [receiptCategoryId, setReceiptCategoryId] = useState<string | undefined>();
  const [exporting, setExporting] = useState(false);
  const [showFullImage, setShowFullImage] = useState(false);
  
  const ynabConfig = getYNABConfig();
  const isYnabConfigured = ynabConfig.token && ynabConfig.budgetId && ynabConfig.accountId;

  useEffect(() => {
    const fetchReceipt = async () => {
      if (!receiptId) {
        setLoading(false);
        return;
      }

      try {
        const response = await getReceipt(receiptId);
        const normalized = normalizeReceiptResponse(response);
        setReceipt(normalized);
        // Extract categoryId from raw response
        const rawResponse = response as Record<string, unknown>;
        const catId = (rawResponse.categoryId ?? rawResponse.category_id) as string | undefined;
        setReceiptCategoryId(catId);
      } catch (error) {
        console.error('Error fetching receipt:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchReceipt();
  }, [receiptId]);


  if (loading) {
    return (
      <MobileLayout>
        <div className="flex flex-col items-center justify-center min-h-[70vh] p-4">
          <Card className="w-full max-w-sm">
            <CardContent className="p-8 space-y-6">
              <Skeleton className="h-20 w-20 rounded-full mx-auto" />
              <Skeleton className="h-6 w-48 mx-auto" />
              <Skeleton className="h-4 w-64 mx-auto" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-10 w-full" />
            </CardContent>
          </Card>
        </div>
      </MobileLayout>
    );
  }

  return (
    <MobileLayout>
      <div className="flex flex-col items-center justify-center min-h-[70vh] p-4 pb-24">
        <Card className="w-full max-w-sm">
          <CardContent className="p-8 space-y-6 text-center">
            <div className="mx-auto w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center">
              <CheckCircle2 className="h-10 w-10 text-primary" />
            </div>

            <div className="space-y-2">
              <h2 className="text-xl font-semibold">Receipt Confirmed!</h2>
              <p className="text-sm text-muted-foreground">
                Your receipt has been successfully saved and confirmed.
              </p>
            </div>

            {/* Receipt Summary */}
            {receipt && (
              <div className="bg-muted/30 rounded-lg p-4 text-left space-y-3">
                {receipt.payee && (
                  <div className="flex items-center gap-3">
                    <Store className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-xs text-muted-foreground">Merchant</p>
                      <p className="font-medium">{receipt.payee}</p>
                    </div>
                  </div>
                )}
                
                {receipt.date && (
                  <div className="flex items-center gap-3">
                    <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div>
                      <p className="text-xs text-muted-foreground">Date</p>
                      <p className="font-medium">{receipt.date}</p>
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  <Receipt className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1">
                    <p className="text-xs text-muted-foreground">Total</p>
                    <p className="text-lg font-bold text-primary">
                      {formatCurrency(receipt.total)}
                    </p>
                  </div>
                  {receipt.vat !== null && (
                    <div className="text-right">
                      <p className="text-xs text-muted-foreground">VAT ({receipt.vatRate || '—'}%)</p>
                      <p className="font-medium">{formatCurrency(receipt.vat)}</p>
                    </div>
                  )}
                </div>

                {receiptCategoryId && (() => {
                  const category = getCategoryById(receiptCategoryId);
                  if (category) {
                    return (
                      <div className="pt-2 border-t border-border">
                        <p className="text-xs text-muted-foreground">Category</p>
                        <div className="flex items-center gap-2 mt-1">
                          <div
                            className="w-3 h-3 rounded-full"
                            style={{ backgroundColor: category.color || '#6B7280' }}
                          />
                          <p className="font-medium">{category.name}</p>
                        </div>
                      </div>
                    );
                  }
                  return null;
                })()}
                {/* Receipt Image Thumbnail */}
                {receipt.imageUrl && (
                  <div className="pt-3 border-t border-border">
                    <p className="text-xs text-muted-foreground mb-2">Receipt Image</p>
                    <div className="relative">
                      <img
                        src={receipt.imageUrl}
                        alt="Receipt"
                        className="w-full h-auto max-h-32 object-contain rounded-lg bg-muted/50 cursor-pointer"
                        onClick={() => setShowFullImage(true)}
                      />
                      <Button
                        size="icon"
                        variant="secondary"
                        className="absolute top-2 right-2 h-8 w-8"
                        onClick={() => setShowFullImage(true)}
                      >
                        <Maximize2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {receiptId && (
              <p className="text-xs text-muted-foreground font-mono">
                ID: {receiptId}
              </p>
            )}

            <div className="space-y-3">
              {isYnabConfigured && receipt && (
                <Button 
                  onClick={async () => {
                    setExporting(true);
                    try {
                      const result = await exportToYNAB([{
                        receiptId: receipt.id,
                        id: receipt.id,
                        payee: receipt.payee || '',
                        date: receipt.date || '',
                        total: receipt.total || 0,
                        vat: receipt.vat,
                        vatRate: receipt.vatRate,
                        category: receipt.category,
                        notes: receipt.notes,
                        status: receipt.status,
                        imageUrl: receipt.imageUrl,
                      }], ynabConfig);
                      
                      if (result.success) {
                        // Update backend with YNAB export timestamp
                        try {
                          await updateReceipt(receiptId!, {
                            ynabExportedAt: new Date().toISOString(),
                          });
                          // Update local state to disable button
                          setReceipt({ ...receipt, ynabExportedAt: new Date().toISOString() });
                        } catch (updateError) {
                          console.warn('Failed to save YNAB export status:', updateError);
                          toast({
                            title: 'Export salvato su YNAB',
                            description: 'Ma non è stato possibile salvare lo stato nel backend',
                            variant: 'default',
                          });
                        }
                        toast({
                          title: 'Exported to YNAB',
                          description: 'Transaction exported successfully',
                        });
                      } else {
                        toast({
                          title: 'YNAB export error',
                          description: result.error || 'Unknown error',
                          variant: 'destructive',
                        });
                      }
                    } catch (error) {
                      toast({
                        title: 'YNAB export error',
                        description: error instanceof Error ? error.message : 'Unknown error',
                        variant: 'destructive',
                      });
                    } finally {
                      setExporting(false);
                    }
                  }}
                  className="w-full"
                  disabled={exporting || !!receipt.ynabExportedAt}
                  variant={receipt.ynabExportedAt ? 'secondary' : 'default'}
                >
                  {exporting ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : receipt.ynabExportedAt ? (
                    <CheckCircle2 className="h-4 w-4 mr-2" />
                  ) : (
                    <Download className="h-4 w-4 mr-2" />
                  )}
                  {receipt.ynabExportedAt ? 'Already exported to YNAB' : 'Export to YNAB'}
                </Button>
              )}
              
              {!isYnabConfigured && (
                <Button 
                  variant="outline"
                  onClick={() => navigate('/settings')} 
                  className="w-full"
                >
                  <Download className="h-4 w-4 mr-2" />
                  Configure YNAB to export
                </Button>
              )}
              
              <Button onClick={() => navigate('/upload')} variant="outline" className="w-full">
                <Plus className="h-4 w-4 mr-2" />
                Add another receipt
              </Button>
              
              <Button 
                variant="ghost" 
                onClick={() => navigate('/receipts')} 
                className="w-full"
              >
                <FileText className="h-4 w-4 mr-2" />
                View all receipts
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
      <BottomNavigation />

      {/* Fullscreen Image Modal */}
      {showFullImage && receipt?.imageUrl && (
        <div
          className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setShowFullImage(false)}
        >
          <Button
            size="icon"
            variant="ghost"
            className="absolute top-4 right-4 h-10 w-10"
            onClick={() => setShowFullImage(false)}
          >
            <X className="h-6 w-6" />
          </Button>
          <img
            src={receipt.imageUrl}
            alt="Receipt full view"
            className="max-w-full max-h-full object-contain rounded-lg"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </MobileLayout>
  );
};

export default Confirmation;
