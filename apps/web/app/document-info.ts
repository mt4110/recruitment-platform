export const kinds = {resume:'履歴書',career_history:'職務経歴書',other:'その他'} as const;
export type Kind=keyof typeof kinds;
export type DocumentInfo={id:string;original_name:string;available:boolean;file_format?:string;document_kind?:Kind;document_version?:number;created_at?:string;size_bytes?:number};
export const documentLabel=(d:DocumentInfo)=>`${d.original_name} · ${kinds[d.document_kind||'other']} 第${d.document_version||1}版 · ${(d.file_format||'pdf').toUpperCase()}`;
export const documentTime=(s:string)=>new Intl.DateTimeFormat('ja-JP',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Tokyo'}).format(new Date(s));
