import { createThrottle } from "@/lib/auth/throttle";

/** Wrong capture tokens, counted per client address. */
export const captureThrottle = createThrottle();
