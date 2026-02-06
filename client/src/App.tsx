import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center p-8">
          <h1 className="text-2xl font-bold mb-4">Resale Community Bot</h1>
          <p className="text-muted-foreground">Bot is running. Use Telegram to interact with it.</p>
        </div>
      </div>
      <Toaster />
    </QueryClientProvider>
  );
}

export default App;
