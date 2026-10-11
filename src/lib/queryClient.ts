import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true } } });
export const refreshDirs = () => queryClient.invalidateQueries({ queryKey: ["dir"] });
export const refreshApps = () => queryClient.invalidateQueries({ queryKey: ["apps"] });
