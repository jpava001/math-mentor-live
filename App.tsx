
import React, { useState, useCallback, useRef, useEffect } from 'react';
import { GoogleGenAI, Modality, Type, FunctionDeclaration } from '@google/genai';
import MathCanvas from './components/MathCanvas';
import { SessionStatus, TranscriptionEntry } from './types';
import { decode, decodeAudioData, createPcmBlob } from './services/audioUtils';

const BASE_SYSTEM_INSTRUCTION = `You are an expert, patient, and friendly math tutor.
The user will share their screen (a handwriting canvas) and talk to you while solving math problems.
Your goal is to guide the user through the solution using the Socratic method.

IMPORTANT RULES:
1. NEVER give the final answer directly.
2. Ask leading questions to help the user realize their own mistakes or find the next step.
3. If the user is stuck, provide a hint or explain a concept related to the problem.
4. Encourage the user and acknowledge their progress.
5. Keep your spoken responses concise so the user can focus on writing.
6. Observe the handwriting canvas closely to understand what the user is writing in real-time.`;

const drawSquareDeclaration: FunctionDeclaration = {
  name: 'draw_square',
  description: 'Draws a red square on the screen to highlight a specific area. Use this to point out mistakes or focus attention.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      x: {
        type: Type.NUMBER,
        description: 'The x-coordinate of the center of the square (0-1000, where 0 is left and 1000 is right).'
      },
      y: {
        type: Type.NUMBER,
        description: 'The y-coordinate of the center of the square (0-1000, where 0 is top and 1000 is bottom).'
      },
      size: {
        type: Type.NUMBER,
        description: 'The size/width of the square (0-1000, relative to screen width).'
      }
    },
    required: ['x', 'y', 'size']
  }
};

const App: React.FC = () => {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [transcriptions, setTranscriptions] = useState<TranscriptionEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [rubric, setRubric] = useState<string>(`## Rubric: Solving a Simple Linear Equation  
**Equation:** 2x = 10  
**Total:** 3 points

### 1. Writes the equation correctly (1 point)
- **1 point:** Writes the equation as given:  
  2x = 10  
- **0 points:** Writes the equation incorrectly.

### 2. Solves the equation using the correct operation (1 point)
- **1 point:** Correctly divides both sides by 2 and shows the step or clearly implies it.  
  x = 5  
- **0.5 points (optional):** Correct method but arithmetic error.  
- **0 points:** Uses an incorrect operation or does not attempt to solve.

### 3. Final answer and clarity (1 point)
- **1 point:** Final answer is correct and clearly stated, and work is easy to follow.  
- **0.5 points:** Final answer is correct but work is unclear or incomplete.  
- **0 points:** Final answer is missing or incorrect.`);
  const [isRubricOpen, setIsRubricOpen] = useState(false);
  const [finalGrade, setFinalGrade] = useState<{ grade: string; feedback: string } | null>(null);
  const [isGrading, setIsGrading] = useState(false);
  
  // Buffers for real-time transcription
  const [activeUserText, setActiveUserText] = useState("");
  const [activeModelText, setActiveModelText] = useState("");
  const currentInputRef = useRef("");
  const currentOutputRef = useRef("");

  // Refs for audio processing
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const sessionRef = useRef<any>(null);
  const intervalRef = useRef<number | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll effect
  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = scrollContainerRef.current.scrollHeight;
    }
  }, [transcriptions, activeUserText, activeModelText]);

  const cleanup = useCallback(() => {
    if (intervalRef.current) window.clearInterval(intervalRef.current);
    if (audioContextInRef.current) audioContextInRef.current.close();
    if (audioContextOutRef.current) audioContextOutRef.current.close();
    sourcesRef.current.forEach(source => source.stop());
    sourcesRef.current.clear();
    sessionRef.current = null;
    setStatus(SessionStatus.IDLE);
    setActiveUserText("");
    setActiveModelText("");
    currentInputRef.current = "";
    currentOutputRef.current = "";
  }, []);

  const handleCanvasRef = useCallback((canvas: HTMLCanvasElement | null) => {
    canvasRef.current = canvas;
  }, []);

  const drawHighlightSquare = (x: number, y: number, size: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    
    // Convert 0-1000 coords to pixels
    const px = (x / 1000) * width;
    const py = (y / 1000) * height;
    const s = (size / 1000) * width;

    ctx.save();
    ctx.strokeStyle = '#ef4444'; // Red-500
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(239, 68, 68, 0.5)';
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.strokeRect(px - s / 2, py - s / 2, s, s);
    ctx.restore();
  };

  const startTutoring = async () => {
    try {
      setStatus(SessionStatus.CONNECTING);
      setError(null);
      setFinalGrade(null);
      setTranscriptions([]);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      const audioCtxIn = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const audioCtxOut = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      audioContextInRef.current = audioCtxIn;
      audioContextOutRef.current = audioCtxOut;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      const hasRubric = rubric && rubric.trim().length > 0;
      
      const behaviorInstruction = hasRubric 
        ? "INITIALIZATION: The teacher has provided a specific rubric/problem below. You MUST start the conversation immediately. Greet the student and explicitly ask them to solve the problem described in the rubric."
        : "INITIALIZATION: No specific rubric is provided. You MUST NOT speak first. Wait for the student to speak, greet you, or start drawing before you say anything.";

      const finalInstruction = `${BASE_SYSTEM_INSTRUCTION}\n\n${behaviorInstruction}\n\n${hasRubric ? `SPECIFIC RUBRIC/INSTRUCTIONS FROM TEACHER:\n${rubric}` : ''}`;

      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-12-2025',
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.CONNECTED);
            const source = audioCtxIn.createMediaStreamSource(stream);
            const scriptProcessor = audioCtxIn.createScriptProcessor(4096, 1, 1);
            scriptProcessor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              const pcmBlob = createPcmBlob(inputData);
              sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
            };
            source.connect(scriptProcessor);
            scriptProcessor.connect(audioCtxIn.destination);

            intervalRef.current = window.setInterval(() => {
              if (canvasRef.current) {
                canvasRef.current.toBlob(async (blob) => {
                  if (blob) {
                    const reader = new FileReader();
                    reader.onloadend = () => {
                      const base64Data = (reader.result as string).split(',')[1];
                      sessionPromise.then(session => session.sendRealtimeInput({
                        media: { data: base64Data, mimeType: 'image/jpeg' }
                      }));
                    };
                    reader.readAsDataURL(blob);
                  }
                }, 'image/jpeg', 0.6);
              }
            }, 1000);
          },
          onmessage: async (message) => {
            // Handle Tool Calls (Annotations)
            if (message.toolCall) {
              const functionResponses = message.toolCall.functionCalls.map(fc => {
                if (fc.name === 'draw_square') {
                  const { x, y, size } = fc.args as any;
                  drawHighlightSquare(x, y, size);
                  return {
                    id: fc.id,
                    name: fc.name,
                    response: { result: 'ok' }
                  };
                }
                return {
                  id: fc.id,
                  name: fc.name,
                  response: { result: 'error: tool not found' }
                };
              });
              
              if (functionResponses.length > 0) {
                sessionPromise.then(session => session.sendToolResponse({ functionResponses }));
              }
            }

            // Audio Output handling
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
              const outCtx = audioContextOutRef.current;
              if (outCtx) {
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, outCtx.currentTime);
                const audioBuffer = await decodeAudioData(decode(base64Audio), outCtx, 24000, 1);
                const source = outCtx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(outCtx.destination);
                source.addEventListener('ended', () => sourcesRef.current.delete(source));
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                sourcesRef.current.add(source);
              }
            }

            // Interruptions
            if (message.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => s.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
              currentOutputRef.current += " [Interrupted]";
              setActiveModelText(currentOutputRef.current);
            }

            // Real-time Transcription aggregation
            if (message.serverContent?.inputTranscription) {
              const text = message.serverContent.inputTranscription.text;
              currentInputRef.current += text;
              setActiveUserText(currentInputRef.current);
            }
            if (message.serverContent?.outputTranscription) {
              const text = message.serverContent.outputTranscription.text;
              currentOutputRef.current += text;
              setActiveModelText(currentOutputRef.current);
            }

            // Turn Completion: Commit buffers to history
            if (message.serverContent?.turnComplete) {
              const historyToAppend: TranscriptionEntry[] = [];
              if (currentInputRef.current.trim()) {
                historyToAppend.push({ role: 'user', text: currentInputRef.current.trim() });
              }
              if (currentOutputRef.current.trim()) {
                historyToAppend.push({ role: 'model', text: currentOutputRef.current.trim() });
              }
              
              if (historyToAppend.length > 0) {
                setTranscriptions(prev => [...prev, ...historyToAppend]);
              }
              
              // Reset buffers for next turn
              currentInputRef.current = "";
              currentOutputRef.current = "";
              setActiveUserText("");
              setActiveModelText("");
            }
          },
          onerror: (e) => {
            console.error('Session error:', e);
            setError('An error occurred during the session.');
            cleanup();
          },
          onclose: () => cleanup()
        },
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
          systemInstruction: finalInstruction,
          tools: [{ functionDeclarations: [drawSquareDeclaration] }],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        }
      });

      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      setError(err.message || 'Failed to initialize session.');
      setStatus(SessionStatus.ERROR);
      cleanup();
    }
  };

  const handleGradeAssignment = async () => {
    if (!canvasRef.current) return;
    
    setIsGrading(true);
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    try {
      const imageData = canvasRef.current.toDataURL('image/jpeg', 0.8).split(',')[1];
      const historyText = transcriptions.map(t => `${t.role}: ${t.text}`).join('\n');
      
      const prompt = `Review the following math assignment completion.
Teacher's Rubric: ${rubric || 'Standard math solving performance.'}

Conversation History:
${historyText}

Based on the provided canvas image and conversation history, generate a grade and helpful feedback.
Return as JSON with keys: "grade" (string) and "feedback" (string, markdown supported).`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: [
          {
            parts: [
              { text: prompt },
              { inlineData: { data: imageData, mimeType: 'image/jpeg' } }
            ]
          }
        ],
        config: {
          responseMimeType: 'application/json'
        }
      });

      const result = JSON.parse(response.text || '{}');
      setFinalGrade({
        grade: result.grade || 'N/A',
        feedback: result.feedback || 'Could not generate feedback.'
      });
      cleanup();
    } catch (err) {
      console.error('Grading failed', err);
      setError('Grading process failed. Please try again.');
    } finally {
      setIsGrading(false);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-50 font-sans text-slate-900">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between shadow-sm z-10">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-600 rounded-lg flex items-center justify-center text-white shadow-md">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800 tracking-tight">Math Mentor Live</h1>
            <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest">Socratic Intelligence</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => setIsRubricOpen(true)}
            className="bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-full text-sm font-bold transition-all border border-slate-200 flex items-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Teacher Rubric
          </button>

          {status === SessionStatus.CONNECTED && (
            <button
              disabled={isGrading}
              onClick={handleGradeAssignment}
              className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-300 text-white px-5 py-2 rounded-full text-sm font-semibold shadow-md transition-all flex items-center gap-2 group"
            >
              {isGrading ? (
                <><div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> Reviewing Work...</>
              ) : (
                <><svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 group-hover:scale-110 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> Finish & Grade</>
              )}
            </button>
          )}

          {status === SessionStatus.CONNECTED ? (
            <button
              onClick={cleanup}
              className="bg-slate-100 hover:bg-red-50 hover:text-red-600 text-slate-600 px-4 py-2 rounded-full text-sm font-bold transition-all border border-slate-200"
            >
              Disconnect
            </button>
          ) : (
            <button
              disabled={status === SessionStatus.CONNECTING}
              onClick={startTutoring}
              className="bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-300 text-white px-6 py-2 rounded-full text-sm font-bold shadow-lg shadow-indigo-100 transition-all flex items-center gap-2"
            >
              {status === SessionStatus.CONNECTING ? 'Connecting...' : 'Start Session'}
            </button>
          )}
        </div>
      </header>

      <main className="flex-1 flex flex-col overflow-hidden p-6 gap-6">
        <div className="flex-[3] min-h-0 bg-white rounded-2xl shadow-sm border border-slate-200 p-2 relative group w-full">
           <MathCanvas onCanvasRef={handleCanvasRef} />
        </div>

        <aside className="flex-1 min-h-0 bg-white rounded-2xl shadow-sm border border-slate-200 flex flex-col overflow-hidden relative w-full">
          <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/50 flex items-center justify-between">
            <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Conversation Stream</h3>
            {status === SessionStatus.CONNECTED && (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></span>
                <span className="text-[10px] font-bold text-emerald-600 uppercase">Live</span>
              </span>
            )}
          </div>
          
          <div ref={scrollContainerRef} className="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-50/30">
            {transcriptions.length === 0 && !activeUserText && !activeModelText && (
              <div className="h-full flex flex-col items-center justify-center text-center px-6 text-slate-400">
                <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10 mb-2 opacity-20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                </svg>
                <p className="text-sm font-medium">Listening for conversation...</p>
              </div>
            )}

            {/* Finalized Logs */}
            {transcriptions.map((t, i) => (
              <div key={i} className={`flex flex-col ${t.role === 'user' ? 'items-end' : 'items-start'} animate-in fade-in slide-in-from-bottom-2 duration-300`}>
                <span className={`text-[10px] font-bold mb-1 uppercase tracking-tighter ${t.role === 'user' ? 'text-indigo-400' : 'text-slate-400'}`}>
                  {t.role === 'user' ? 'Student' : 'Mentor'}
                </span>
                <div className={`max-w-[90%] px-4 py-2.5 rounded-2xl text-[13px] leading-relaxed font-medium ${
                  t.role === 'user' 
                    ? 'bg-indigo-600 text-white rounded-tr-none shadow-md shadow-indigo-100' 
                    : 'bg-white border border-slate-200 text-slate-700 rounded-tl-none shadow-sm'
                }`}>
                  {t.text}
                </div>
              </div>
            ))}

            {/* Real-time Streaming Bubbles */}
            {activeUserText && (
              <div className="flex flex-col items-end animate-in fade-in slide-in-from-bottom-1">
                <span className="text-[10px] font-bold mb-1 uppercase tracking-tighter text-indigo-400 opacity-60">Student Speaking...</span>
                <div className="max-w-[90%] px-4 py-2.5 rounded-2xl text-[13px] leading-relaxed font-medium bg-indigo-50 text-indigo-700 border border-indigo-100 rounded-tr-none italic">
                  {activeUserText}
                  <span className="inline-block w-1 h-3 bg-indigo-400 ml-1 animate-pulse"></span>
                </div>
              </div>
            )}

            {activeModelText && (
              <div className="flex flex-col items-start animate-in fade-in slide-in-from-bottom-1">
                <span className="text-[10px] font-bold mb-1 uppercase tracking-tighter text-slate-400 opacity-60">Mentor Thinking...</span>
                <div className="max-w-[90%] px-4 py-2.5 rounded-2xl text-[13px] leading-relaxed font-medium bg-white border border-indigo-200 text-slate-700 rounded-tl-none italic shadow-sm">
                  {activeModelText}
                  <span className="inline-block w-1 h-3 bg-indigo-400 ml-1 animate-pulse"></span>
                </div>
              </div>
            )}
          </div>

          {/* Grading Report Overlay */}
          {finalGrade && (
            <div className="absolute inset-0 bg-white/98 z-20 overflow-y-auto p-8 flex flex-col items-center animate-in zoom-in-95 duration-500 backdrop-blur-sm">
              <div className="w-20 h-20 bg-emerald-50 rounded-full flex items-center justify-center text-emerald-500 mb-6 shadow-inner">
                 <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                 </svg>
              </div>
              <h2 className="text-xl font-black text-slate-800 uppercase tracking-widest mb-1">Performance Report</h2>
              <div className="text-5xl font-black text-emerald-600 mb-8 tracking-tighter">
                 {finalGrade.grade}
              </div>
              <div className="w-full bg-white rounded-2xl p-6 border border-slate-100 shadow-xl shadow-slate-200/50 text-sm text-slate-700 prose prose-slate max-w-none">
                <div className="font-bold text-xs uppercase tracking-widest text-slate-400 mb-4 border-b pb-2">Feedback & Guidance</div>
                <div className="whitespace-pre-wrap leading-loose">
                  {finalGrade.feedback}
                </div>
              </div>
              <button 
                onClick={() => setFinalGrade(null)}
                className="mt-8 bg-slate-900 text-white px-8 py-3 rounded-full text-sm font-bold shadow-lg shadow-slate-200 hover:scale-105 active:scale-95 transition-all"
              >
                Close Report
              </button>
            </div>
          )}
        </aside>
      </main>

      {/* Teacher Rubric Modal */}
      {isRubricOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-900/60 backdrop-blur-sm">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl flex flex-col h-[85vh] animate-in zoom-in-95 fade-in duration-200 overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <div>
                <h3 className="text-lg font-bold text-slate-800">Teacher Rubric & Session Constraints</h3>
                <p className="text-sm text-slate-500">Define the problem and grading criteria for the AI tutor.</p>
              </div>
              <button 
                onClick={() => setIsRubricOpen(false)}
                className="p-2 hover:bg-slate-200 rounded-full transition-colors text-slate-500"
              >
                <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            
            <div className="flex-1 p-6 flex flex-col min-h-0 bg-slate-50">
              <textarea
                value={rubric}
                onChange={(e) => setRubric(e.target.value)}
                className="flex-1 w-full p-6 bg-white border border-slate-200 rounded-xl resize-none outline-none focus:ring-2 focus:ring-indigo-500 text-base font-mono leading-relaxed text-slate-700 shadow-sm"
                placeholder="# Problem Statement&#10;Solve for x...&#10;&#10;# Success Criteria&#10;1. Correctly identifies variables..."
                autoFocus
              />
            </div>
            
            <div className="px-6 py-4 border-t border-slate-100 bg-white flex justify-between items-center">
              <button
                onClick={() => setRubric('')}
                className="text-sm text-rose-500 font-bold hover:text-rose-700 transition-colors"
              >
                Clear Rubric
              </button>
              <button
                onClick={() => setIsRubricOpen(false)}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-2.5 rounded-lg text-sm font-bold shadow-lg shadow-indigo-100 transition-all active:scale-95"
              >
                Save Configuration
              </button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="fixed bottom-6 left-6 right-6 bg-red-600 text-white p-4 rounded-xl shadow-2xl flex items-center justify-between z-50 animate-in slide-in-from-bottom-8">
          <div className="flex items-center gap-3">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="font-bold text-sm tracking-tight">{error}</span>
          </div>
          <button onClick={() => setError(null)} className="p-2 hover:bg-white/10 rounded-full transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
};

export default App;
