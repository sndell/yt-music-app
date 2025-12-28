/**
 * API Module
 * 
 * Central export point for the Python bridge and all API types.
 */

export { PyBridge, unwrap, unwrapOr, isInPyWebView } from "./bridge";

export type {
  // Result pattern
  Result,
  ApiError,
  
  // Shared types
  Thumbnail,
  Author,
  Artist,
  Album,
  
  // Playlist types
  PlaylistSummary,
  PlaylistDetails,
  Track,
  LikeStatus,
  VideoType,
  PrivacyStatus,
  
  // API method types (for advanced usage)
  ApiMethodName,
  ApiParams,
  ApiResponse,
  ApiMethods,
} from "./types";
