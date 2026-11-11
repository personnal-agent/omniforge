import React, { useState } from 'react';
import { Copy, Check, Square, Terminal, Code2, Sparkles, ChevronDown, ChevronUp } from 'lucide-react';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LlmChatViewProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  onStopStreaming: () => void;
  endpointUrl?: string;
  className?: string;
}

type SnippetType = 'curl' | 'python' | 'cursor';

export const LlmChatView: React.FC<LlmChatViewProps> = ({
  messages,
  isStreaming,
  onStopStreaming,
  endpointUrl = 'http://localhost:8000/v1/chat/completions',
  className = '',
}) => {
  const [activeSnippet, setActiveSnippet] = useState<SnippetType>('curl');
  const [copied, setCopied] = useState(false);
  const [showApiBanner, setShowApiBanner] = useState(true);

  const snippets: Record<SnippetType, string> = {
    curl: `curl ${endpointUrl} \\
  -H "Content-Type: application/json" \\
  -d '{"model": "Llama-3-8B", "messages": [{"role": "user", "content": "Hello"}]}'`,
    python: `from openai import OpenAI

client = OpenAI(base_url="${endpointUrl.replace('/chat/completions', '')}", api_key="colab")
response = client.chat.completions.create(
    model="Llama-3-8B",
    messages=[{"role": "user", "content": "Hello"}],
)`,
    cursor: `// Cursor / Continue.dev configuration:
{
  "apiBase": "${endpointUrl.replace('/chat/completions', '')}",
  "model": "Llama-3-8B"
}`,
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(snippets[activeSnippet]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
    }
  };

  return (
    <div className={`w-full flex flex-col space-y-3 ${className}`}>
      {/* Bandeau d'information d'endpoint API (OpenAI Compatible) */}
      <div className="bg-gray-900/90 dark:bg-black/80 text-gray-200 rounded-2xl border border-gray-800 p-3 text-xs shadow-lg backdrop-blur-md">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-mono text-gray-300 font-semibold truncate">
              {endpointUrl}
            </span>
            <span className="hidden sm:inline-block px-1.5 py-0.5 rounded text-[10px] bg-indigo-900/60 text-indigo-300 font-mono">
              OpenAI API Compatible
            </span>
          </div>

          <div className="flex items-center space-x-1">
            <button
              type="button"
              onClick={() => setShowApiBanner(!showApiBanner)}
              className="p-1 rounded text-gray-400 hover:text-white transition-colors"
              title={showApiBanner ? 'Hide API snippets' : 'Show API snippets'}
            >
              {showApiBanner ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {showApiBanner && (
          <div className="mt-2.5 pt-2.5 border-t border-gray-800">
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex space-x-1">
                <button
                  type="button"
                  onClick={() => setActiveSnippet('curl')}
                  className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                    activeSnippet === 'curl'
                      ? 'bg-gray-800 text-white font-bold'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <Terminal className="w-3 h-3" />
                  <span>cURL</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSnippet('python')}
                  className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                    activeSnippet === 'python'
                      ? 'bg-gray-800 text-white font-bold'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <Code2 className="w-3 h-3" />
                  <span>Python</span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSnippet('cursor')}
                  className={`flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] font-mono transition-colors ${
                    activeSnippet === 'cursor'
                      ? 'bg-gray-800 text-white font-bold'
                      : 'text-gray-400 hover:text-gray-200'
                  }`}
                >
                  <Sparkles className="w-3 h-3" />
                  <span>Cursor</span>
                </button>
              </div>

              <button
                type="button"
                onClick={handleCopy}
                className="flex items-center space-x-1 px-2 py-0.5 rounded text-[11px] text-gray-300 hover:text-white bg-gray-800/80 hover:bg-gray-800 transition-colors"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                <span>{copied ? 'Copied!' : 'Copy'}</span>
              </button>
            </div>

            <pre className="p-2 bg-black/60 rounded-xl font-mono text-[11px] text-gray-300 overflow-x-auto whitespace-pre leading-relaxed border border-gray-800/80">
              {snippets[activeSnippet]}
            </pre>
          </div>
        )}
      </div>


      {/* Messages History */}
      {messages.length > 0 && (
        <div className="max-h-60 overflow-y-auto space-y-3 p-3 bg-white/50 dark:bg-gray-900/50 backdrop-blur-sm rounded-2xl border border-gray-100 dark:border-gray-800">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex flex-col ${
                msg.role === 'user' ? 'items-end' : 'items-start'
              }`}
            >
              <div className="flex items-center space-x-1 mb-1 px-1">
                <span className="text-[10px] uppercase font-bold text-gray-400 tracking-wider">
                  {msg.role === 'user' ? 'You' : 'Assistant'}
                </span>
              </div>
              <div
                className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-xs leading-relaxed ${
                  msg.role === 'user'
                    ? 'bg-indigo-600 text-white rounded-br-sm shadow-sm'
                    : 'bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 rounded-bl-sm border border-gray-200/50 dark:border-gray-700/50'
                }`}
              >
                <div className="whitespace-pre-wrap">{msg.content}</div>
              </div>
            </div>
          ))}

          {isStreaming && (
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center space-x-1.5 text-xs text-indigo-600 dark:text-indigo-400">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-600 animate-ping" />
                <span className="font-medium">Génération en cours...</span>
              </div>
              <button
                type="button"
                onClick={onStopStreaming}
                aria-label="Stop generating"
                className="flex items-center space-x-1 px-2.5 py-1 bg-rose-50 text-rose-600 hover:bg-rose-100 dark:bg-rose-950/40 dark:text-rose-400 dark:hover:bg-rose-950/60 rounded-lg text-xs font-semibold border border-rose-200 dark:border-rose-800 transition-colors"
              >
                <Square className="w-3 h-3 fill-current" />
                <span>Stop generating</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
