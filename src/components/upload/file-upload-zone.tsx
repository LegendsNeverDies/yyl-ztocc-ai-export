"use client";

import { useState, useCallback, useRef, type DragEvent } from "react";
import { Upload, FileSpreadsheet, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

interface FileUploadZoneProps {
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

const ALLOWED_EXTENSIONS = [".xlsx", ".xls", ".pdf"];
const ALLOWED_MIMES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/pdf",
];

export function FileUploadZone({ onFileSelected, disabled }: FileUploadZoneProps) {
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const validateAndSelect = useCallback(
    (file: File) => {
      const ext = "." + file.name.split(".").pop()?.toLowerCase();
      if (!ALLOWED_EXTENSIONS.includes(ext) && !ALLOWED_MIMES.includes(file.type)) {
        return false;
      }
      onFileSelected(file);
      return true;
    },
    [onFileSelected]
  );

  const handleDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault();
      setIsDragOver(false);
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) validateAndSelect(file);
    },
    [disabled, validateAndSelect]
  );

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragOver(false);
  }, []);

  const handleClick = () => {
    if (!disabled) inputRef.current?.click();
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) validateAndSelect(file);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div
      className={cn(
        "drop-zone",
        isDragOver && "drag-over",
        disabled && "pointer-events-none opacity-50"
      )}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onClick={handleClick}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.pdf"
        onChange={handleChange}
        className="hidden"
      />
      <Upload className="mx-auto h-12 w-12 text-[#0fc6c2] opacity-60" />
      <p className="mt-3 text-base font-medium text-[#1d2129]">
        拖拽文件到此处，或<span className="text-[#0fc6c2]">点击上传</span>
      </p>
      <p className="mt-1 text-sm text-[#86909c]">
        支持 Excel (.xlsx / .xls) 和 PDF 格式
      </p>
      <div className="mt-3 flex items-center justify-center gap-4">
        <span className="inline-flex items-center gap-1 text-xs text-[#86909c]">
          <FileSpreadsheet className="h-4 w-4" /> Excel
        </span>
        <span className="inline-flex items-center gap-1 text-xs text-[#86909c]">
          <FileText className="h-4 w-4" /> PDF
        </span>
      </div>
    </div>
  );
}
