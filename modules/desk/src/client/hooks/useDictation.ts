import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

interface RecognitionAlternative {
  readonly transcript: string;
}

interface RecognitionResult {
  readonly isFinal: boolean;
  readonly [index: number]: RecognitionAlternative;
}

interface RecognitionResultList {
  readonly length: number;
  readonly [index: number]: RecognitionResult;
}

interface RecognitionResultEvent extends Event {
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
}

interface RecognitionErrorEvent extends Event {
  readonly error: string;
}

interface BrowserSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionResultEvent) => void) | null;
  onerror: ((event: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

interface SpeechWindow extends Window {
  readonly SpeechRecognition?: SpeechRecognitionConstructor;
  readonly webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

export interface DictationControl {
  readonly supported: boolean;
  readonly listening: boolean;
  readonly error: string | null;
  readonly toggle: () => void;
  readonly stop: () => void;
  readonly clearError: () => void;
}

/** Browser-native dictation keeps audio on the browser side and adds no service dependency. */
export function useDictation(
  value: string,
  setValue: Dispatch<SetStateAction<string>>,
  disabled = false,
): DictationControl {
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);
  const baseTextRef = useRef('');
  const finalTextRef = useRef('');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const constructor = speechRecognitionConstructor();
  const supported = constructor !== null;

  const stop = useCallback((): void => {
    const recognition = recognitionRef.current;
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      recognitionRef.current = null;
      setListening(false);
    }
  }, []);

  const toggle = useCallback((): void => {
    if (recognitionRef.current) {
      stop();
      return;
    }
    if (!constructor || disabled) return;

    const recognition = new constructor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    baseTextRef.current = value.trim();
    finalTextRef.current = '';
    setError(null);
    setListening(true);
    recognitionRef.current = recognition;

    recognition.onresult = (event): void => {
      let finalText = finalTextRef.current;
      let interimText = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        const transcript = result?.[0]?.transcript.trim();
        if (!result || !transcript) continue;
        if (result.isFinal) finalText = joinText(finalText, transcript);
        else interimText = joinText(interimText, transcript);
      }
      finalTextRef.current = finalText;
      const dictated = joinText(finalText, interimText);
      setValue(joinText(baseTextRef.current, dictated));
    };
    recognition.onerror = (event): void => {
      if (event.error !== 'aborted') setError(dictationError(event.error));
    };
    recognition.onend = (): void => {
      if (recognitionRef.current === recognition) recognitionRef.current = null;
      setListening(false);
    };

    try {
      recognition.start();
    } catch {
      recognitionRef.current = null;
      setListening(false);
      setError('Dictation could not start.');
    }
  }, [constructor, disabled, setValue, stop, value]);

  useEffect(() => {
    if (disabled) stop();
  }, [disabled, stop]);

  useEffect(() => () => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    recognition.onresult = null;
    recognition.onerror = null;
    recognition.onend = null;
    recognition.abort();
  }, []);

  return {
    supported,
    listening,
    error,
    toggle,
    stop,
    clearError: () => setError(null),
  };
}

function speechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const speechWindow = window as SpeechWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function joinText(left: string, right: string): string {
  return [left.trim(), right.trim()].filter(Boolean).join(' ');
}

function dictationError(code: string): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Microphone access was denied.';
  if (code === 'audio-capture') return 'No microphone is available.';
  if (code === 'no-speech') return 'No speech was detected.';
  if (code === 'network') return 'Voice recognition could not connect.';
  return 'Dictation stopped unexpectedly.';
}
