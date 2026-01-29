import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/hooks/use-toast';
import { getReceipts, Receipt } from '@/lib/api';
import { isAuthenticated } from '@/lib/auth';
import { getDraftOverride } from '@/lib/receiptDraftStore';
import { setReceiptsCache } from '@/lib/receiptCache';
import { formatCurrency } from '@/lib/utils';
import { useInfiniteScroll } from '@/hooks/useInfiniteScroll';
import { useCategories } from '@/hooks/useCategories';
import { 
  ArrowLeft, 
  Receipt as ReceiptIcon, 
  Search, 
  Calendar,
  RefreshCw,
  FileText,
  Loader2,
  Download,
  CheckCircle2
} from 'lucide-react';
import MobileLayout from '@/components/MobileLayout';
import BottomNavigation from '@/components/BottomNavigation';
import { format } from 'date-fns';

type ReceiptStatus = 'CREATED' | 'EXTRACTED' | 'DRAFT' | 'NEW' | 'CONFIRMED' | 'FAILED';

const statusConfig: Record<ReceiptStatus, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  CREATED: { label: 'Processing', variant: 'secondary' },
  EXTRACTED: { label: 'Ready', variant: 'outline' },
  DRAFT: { label: 'Draft', variant: 'outline' },
  NEW: { label: 'Draft', variant: 'outline' },
  CONFIRMED: { label: 'Confirmed', variant: 'default' },
  FAILED: { label: 'Failed', variant: 'destructive' },
};

const isDraftStatus = (status?: string) => status === 'DRAFT' || status === 'NEW' || status === 'EXTRACTED';

const PAGE_SIZE = 20;

const Receipts = () => {
  const navigate = useNavigate();
  const { categories } = useCategories();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [allReceipts, setAllReceipts] = useState<Receipt[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const [ynabFilter, setYnabFilter] = useState<'all' | 'exported' | 'not-exported'>('all');

  const authenticated = isAuthenticated();

  const applyLocalOverrides = (data: Receipt[]) => {
    return data.map((r) => {
      const override = getDraftOverride(r.receiptId);
      if (!override) return r;
      return {
        ...r,
        ...override,
        total: override.total ?? r.total,
        vat: override.vat ?? r.vat,
        vatRate: override.vatRate ?? r.vatRate,
        date: override.date ?? r.date,
        payee: override.payee ?? r.payee,
      };
    });
  };

  const sortByDate = (data: Receipt[]) => {
    return [...data].sort((a, b) =>
      new Date(b.date || b.createdAt || 0).getTime() - new Date(a.date || a.createdAt || 0).getTime()
    );
  };

  const fetchReceipts = async () => {
    try {
      setLoading(true);
      
      // Fetch all receipts from API (backend may not support pagination)
      const { receipts: data } = await getReceipts({ limit: 1000 });

      const withLocalOverrides = applyLocalOverrides(data);
      const sorted = sortByDate(withLocalOverrides);
      
      setAllReceipts(sorted);
      setDisplayCount(PAGE_SIZE);
      setReceiptsCache(sorted);
    } catch (error) {
      toast({
        title: 'Error loading receipts',
        description: error instanceof Error ? error.message : 'An error occurred',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  // Filter receipts by search query and YNAB export status
  const filteredReceipts = useMemo(() => {
    let result = allReceipts;
    
    // Apply YNAB filter
    if (ynabFilter === 'exported') {
      result = result.filter((r) => !!r.ynabExportedAt);
    } else if (ynabFilter === 'not-exported') {
      result = result.filter((r) => !r.ynabExportedAt);
    }
    
    // Apply search filter
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      result = result.filter((receipt) =>
        receipt.payee?.toLowerCase().includes(query) ||
        receipt.category?.toLowerCase().includes(query) ||
        receipt.receiptId.toLowerCase().includes(query)
      );
    }
    
    return result;
  }, [allReceipts, searchQuery, ynabFilter]);

  // Paginated display (client-side)
  const displayedReceipts = useMemo(() => {
    return filteredReceipts.slice(0, displayCount);
  }, [filteredReceipts, displayCount]);

  const hasMore = displayCount < filteredReceipts.length;

  const loadMore = useCallback(() => {
    if (!hasMore || loadingMore) return;
    setLoadingMore(true);
    setDisplayCount((prev) => Math.min(prev + PAGE_SIZE, filteredReceipts.length));
  }, [hasMore, filteredReceipts.length, loadingMore]);

  // Stop the "loading more" indicator after state updates
  useEffect(() => {
    if (loadingMore) setLoadingMore(false);
  }, [displayCount, loadingMore]);

  const scrollContainerRef = useInfiniteScroll({
    onLoadMore: loadMore,
    hasMore,
    loading: loadingMore,
    threshold: 200,
  });

  useEffect(() => {
    if (!authenticated) {
      navigate('/settings');
      return;
    }
    fetchReceipts();
  }, [authenticated, navigate]);

  // Reset display count when search changes
  useEffect(() => {
    setDisplayCount(PAGE_SIZE);
  }, [searchQuery]);

  const handleRefresh = () => {
    setRefreshing(true);
    fetchReceipts();
  };

  const handleReceiptClick = (receipt: Receipt) => {
    if (receipt.status === 'CREATED') {
      navigate(`/processing/${receipt.receiptId}`);
    } else if (receipt.status === 'CONFIRMED') {
      navigate(`/confirmation/${receipt.receiptId}`);
    } else {
      navigate(`/review/${receipt.receiptId}`);
    }
  };

  const formatDate = (dateString?: string) => {
    if (!dateString) return 'No date';
    try {
      return format(new Date(dateString), 'MMM d, yyyy');
    } catch {
      return dateString;
    }
  };

  const formatExportDate = (isoString: string) => {
    try {
      return format(new Date(isoString), 'MMM d, yyyy');
    } catch {
      return 'Exported';
    }
  };

  if (loading) {
    return (
      <MobileLayout>
        <div className="p-4 space-y-4">
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10" />
            <Skeleton className="h-7 w-32" />
          </div>
          <Skeleton className="h-10 w-full" />
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      </MobileLayout>
    );
  }

  return (
    <MobileLayout>
      <div 
        ref={scrollContainerRef}
        className="h-full overflow-y-auto p-4 space-y-4 pb-24"
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigate('/')}
              className="shrink-0"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="flex items-center gap-2">
              <FileText className="h-6 w-6 text-primary" />
              <h1 className="text-xl font-semibold">Receipts</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              onClick={() => navigate('/export')}
            >
              <Download className="h-5 w-5" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={handleRefresh}
              disabled={refreshing}
            >
              <RefreshCw className={`h-5 w-5 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search receipts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* YNAB Filter */}
        <div className="flex gap-2">
          <Button
            variant={ynabFilter === 'all' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setYnabFilter('all')}
          >
            All
          </Button>
          <Button
            variant={ynabFilter === 'exported' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setYnabFilter('exported')}
          >
            <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
            Exported
          </Button>
          <Button
            variant={ynabFilter === 'not-exported' ? 'default' : 'outline'}
            size="sm"
            onClick={() => setYnabFilter('not-exported')}
          >
            Not exported
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-2xl font-bold">{allReceipts.length}</p>
              <p className="text-xs text-muted-foreground">Total</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-2xl font-bold text-primary">
                {allReceipts.filter((r) => r.status === 'CONFIRMED').length}
              </p>
              <p className="text-xs text-muted-foreground">Confirmed</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-2xl font-bold text-muted-foreground">
                {allReceipts.filter((r) => isDraftStatus(r.status)).length}
              </p>
              <p className="text-xs text-muted-foreground">Drafts</p>
            </CardContent>
          </Card>
        </div>

        {/* Receipt List */}
        {filteredReceipts.length === 0 ? (
          <Card>
            <CardContent className="p-8 text-center">
              <ReceiptIcon className="h-12 w-12 mx-auto text-muted-foreground/50 mb-4" />
              <p className="text-muted-foreground">
                {searchQuery ? 'No receipts match your search' : 'No receipts yet'}
              </p>
              {!searchQuery && (
                <Button
                  variant="outline"
                  className="mt-4"
                  onClick={() => navigate('/upload')}
                >
                  Upload your first receipt
                </Button>
              )}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {displayedReceipts.map((receipt) => {
              const status = (receipt.status as ReceiptStatus) || 'CREATED';
              const config = statusConfig[status] || statusConfig.CREATED;
              
              return (
                <Card
                  key={receipt.receiptId}
                  className="cursor-pointer hover:shadow-md transition-shadow active:scale-[0.99]"
                  onClick={() => handleReceiptClick(receipt)}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <h3 className="font-medium truncate">
                            {receipt.payee || 'Unknown Merchant'}
                          </h3>
                          <Badge variant={config.variant} className="shrink-0">
                            {config.label}
                          </Badge>
                          {receipt.ynabExportedAt && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <div className="flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium shrink-0">
                                  <CheckCircle2 className="h-3 w-3" />
                                  <span>YNAB</span>
                                </div>
                              </TooltipTrigger>
                              <TooltipContent>
                                <p>Exported to YNAB on {formatExportDate(receipt.ynabExportedAt)}</p>
                              </TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <div className="flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                          <div className="flex items-center gap-1">
                            <Calendar className="h-3.5 w-3.5" />
                            <span>{formatDate(receipt.date || receipt.createdAt)}</span>
                          </div>
                          {receipt.categoryId && categories.includes(receipt.categoryId) && (
                            <div
                              className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-xs font-medium bg-primary/10 text-primary"
                            >
                              <div className="w-2 h-2 rounded-full bg-primary" />
                              <span>{receipt.categoryId}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <p className="font-semibold text-lg shrink-0">
                        {formatCurrency(receipt.total)}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
            
            {/* Loading more indicator or Load More button */}
            {hasMore && (
              <div className="flex justify-center py-4">
                {loadingMore ? (
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                ) : (
                  <Button variant="outline" onClick={loadMore}>
                    Load more ({filteredReceipts.length - displayCount} remaining)
                  </Button>
                )}
              </div>
            )}
            
            {/* End of list indicator */}
            {!hasMore && displayedReceipts.length > 0 && !searchQuery && allReceipts.length > PAGE_SIZE && (
              <p className="text-center text-sm text-muted-foreground py-4">
                All receipts loaded
              </p>
            )}
          </div>
        )}
      </div>
      <BottomNavigation />
    </MobileLayout>
  );
};

export default Receipts;