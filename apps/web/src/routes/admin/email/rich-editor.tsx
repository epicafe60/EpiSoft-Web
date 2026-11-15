import { useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Code2,
  Heading2,
  ImagePlus,
  Italic,
  Link2,
  List,
  ListOrdered,
  Redo2,
  Underline,
  Undo2,
  Upload,
} from 'lucide-react';
import {
  EMAIL_ASSET_PATH,
  EMAIL_LIMITS,
  type EmailAssetInfo,
  type TemplateVariable,
} from '@episoft/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { Alert, Input } from '@/components/ui/form';
import { Select, Textarea } from '@/components/ui/inputs';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';

/** The images of the library: choose one to insert, or add a new one. */
export function ImagePicker({
  open,
  onClose,
  onPick,
  title = 'Insérer une image',
  description = 'Les images sont jointes au courriel : elles s’affichent sans dépendre d’une adresse publique.',
  types = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  pickVerb = 'Insérer',
}: {
  open: boolean;
  onClose: () => void;
  onPick: (asset: { id: string; name: string }) => void;
  title?: string;
  description?: string;
  /** The kinds of image that can be chosen or added (a PDF only draws PNG and JPEG). */
  types?: string[];
  pickVerb?: string;
}) {
  const queryClient = useQueryClient();
  const assets = useQuery({
    queryKey: ['email-assets'],
    queryFn: () => api.get<EmailAssetInfo[]>('/email-assets'),
    enabled: open,
  });
  const add = useMutation({
    mutationFn: (file: File) => {
      if (file.size > EMAIL_LIMITS.imageBytes)
        throw new Error(
          `Image trop lourde : ${Math.round(EMAIL_LIMITS.imageBytes / 1024)} Ko au plus.`,
        );
      return api.postImage<{ id: string; name: string }>('/email-assets', file);
    },
    onSuccess: (a) => {
      void queryClient.invalidateQueries({ queryKey: ['email-assets'] });
      onPick(a);
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      className="max-w-2xl"
    >
      <div className="grid gap-4">
        <label className="inline-flex w-fit cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent">
          <Upload className="size-4" aria-hidden />
          Ajouter une image ({types.map((t) => t.replace('image/', '').toUpperCase()).join(', ')})
          <input
            type="file"
            accept={types.join(',')}
            className="sr-only"
            aria-label="Ajouter une image"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) add.mutate(f);
              e.target.value = '';
            }}
          />
        </label>
        {add.error ? <Alert>{add.error.message}</Alert> : null}
        {assets.data?.length === 0 ? (
          <p className="text-sm text-muted-foreground">Aucune image pour l’instant.</p>
        ) : null}
        <ul className="grid max-h-80 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
          {(assets.data ?? [])
            .filter((a) => types.includes(a.mime))
            .map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  className="grid w-full gap-1 rounded-md border p-2 text-left hover:bg-accent"
                  onClick={() => onPick(a)}
                  aria-label={`${pickVerb} l’image ${a.name}`}
                >
                  <img
                    src={`${EMAIL_ASSET_PATH}${a.id}`}
                    alt=""
                    className="h-20 w-full rounded bg-muted object-contain"
                  />
                  <span className="truncate text-xs">{a.name}</span>
                </button>
              </li>
            ))}
        </ul>
      </div>
    </Dialog>
  );
}

function ToolButton({
  label,
  active,
  onClick,
  children,
  disabled,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      aria-label={label}
      title={label}
      aria-pressed={active ?? false}
      disabled={disabled ?? false}
      className={cn('size-8 p-0', active && 'bg-accent')}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function LinkDialog({
  open,
  initial,
  onClose,
  onApply,
}: {
  open: boolean;
  initial: string;
  onClose: () => void;
  onApply: (href: string | null) => void;
}) {
  const [href, setHref] = useState(initial);
  return (
    <Dialog open={open} onClose={onClose} title="Lien">
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          onApply(href.trim() || null);
        }}
      >
        <label className="grid gap-1 text-sm">
          Adresse du lien
          <Input
            value={href}
            onChange={(e) => setHref(e.target.value)}
            placeholder="https://… ou {{lien}}"
            autoFocus
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Une adresse web (https://…), une adresse de courriel (mailto:…) ou une variable comme{' '}
          <code>{'{{lien}}'}</code>. Laissez vide pour retirer le lien.
        </p>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Annuler
          </Button>
          <Button type="submit">Appliquer</Button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * A text editor for the wording of an e-mail: formatting, links, images of the library, variables
 * to insert, and the HTML itself for those who want it. What is typed is cleaned by the server when
 * it is saved, whatever this editor produces.
 */
export function RichEditor({
  label,
  value,
  onChange,
  variables = [],
  minHeight = '14rem',
  variant = 'email',
}: {
  label: string;
  value: string;
  onChange: (html: string) => void;
  variables?: readonly TemplateVariable[];
  minHeight?: string;
  /** « pdf »: text only (formatting, lists, alignment, colour): a PDF has no link and no image. */
  variant?: 'email' | 'pdf';
}) {
  const pdf = variant === 'pdf';
  const [mode, setMode] = useState<'visual' | 'html'>('visual');
  const [pickImage, setPickImage] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: pdf ? false : { openOnClick: false, autolink: false } }),
      ...(pdf ? [] : [Image]),
      TextStyle,
      Color,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content: value,
    onUpdate: ({ editor: e }) => onChange(e.getHTML()),
    editorProps: {
      attributes: {
        'aria-label': label,
        role: 'textbox',
        'aria-multiline': 'true',
        class: 'prose-sm max-w-none px-3 py-2 outline-none [&_img]:max-w-full [&_p]:my-2',
        style: `min-height:${minHeight}`,
      },
    },
  });

  const toSource = () => setMode('html');
  const toVisual = () => {
    editor?.commands.setContent(value, { emitUpdate: false });
    setMode('visual');
  };

  return (
    <div className="grid gap-2">
      <div
        className="flex flex-wrap items-center gap-1 rounded-t-md border bg-muted/40 p-1"
        role="toolbar"
        aria-label={`Mise en forme : ${label}`}
      >
        {editor && mode === 'visual' ? (
          <Toolbar
            editor={editor}
            onLink={pdf ? undefined : () => setLink(editor.getAttributes('link').href ?? '')}
            onImage={pdf ? undefined : () => setPickImage(true)}
          />
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {variables.length > 0 && mode === 'visual' && editor ? (
            <Select
              aria-label="Insérer une variable"
              className="h-8 w-48 text-xs"
              value=""
              onChange={(e) => {
                if (e.target.value)
                  editor.chain().focus().insertContent(`{{${e.target.value}}}`).run();
              }}
            >
              <option value="">Insérer une variable…</option>
              {variables.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.label} {`{{${v.name}}}`}
                </option>
              ))}
            </Select>
          ) : null}
          {pdf ? null : (
            <ToolButton
              label={mode === 'html' ? 'Revenir à l’éditeur' : 'Voir le code HTML'}
              active={mode === 'html'}
              onClick={mode === 'html' ? toVisual : toSource}
            >
              <Code2 className="size-4" />
            </ToolButton>
          )}
        </div>
      </div>
      {mode === 'visual' ? (
        <div className="-mt-2 rounded-b-md border border-t-0 bg-background">
          <EditorContent editor={editor} />
        </div>
      ) : (
        <Textarea
          aria-label={`Code HTML : ${label}`}
          className="-mt-2 rounded-t-none font-mono text-xs"
          rows={14}
          value={value}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      <ImagePicker
        open={pickImage}
        onClose={() => setPickImage(false)}
        onPick={(a) => {
          editor
            ?.chain()
            .focus()
            .setImage({ src: `${EMAIL_ASSET_PATH}${a.id}`, alt: a.name })
            .run();
          setPickImage(false);
        }}
      />
      {link !== null ? (
        <LinkDialog
          open
          initial={link}
          onClose={() => setLink(null)}
          onApply={(href) => {
            const chain = editor?.chain().focus().extendMarkRange('link');
            if (href) chain?.setLink({ href }).run();
            else chain?.unsetLink().run();
            setLink(null);
          }}
        />
      ) : null}
    </div>
  );
}

function Toolbar({
  editor,
  onLink,
  onImage,
}: {
  editor: Editor;
  onLink?: () => void;
  onImage?: () => void;
}) {
  const colorRef = useRef<HTMLInputElement>(null);
  const chain = () => editor.chain().focus();
  return (
    <>
      <ToolButton
        label="Annuler"
        onClick={() => chain().undo().run()}
        disabled={!editor.can().undo()}
      >
        <Undo2 className="size-4" />
      </ToolButton>
      <ToolButton
        label="Rétablir"
        onClick={() => chain().redo().run()}
        disabled={!editor.can().redo()}
      >
        <Redo2 className="size-4" />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      <ToolButton
        label="Gras"
        active={editor.isActive('bold')}
        onClick={() => chain().toggleBold().run()}
      >
        <Bold className="size-4" />
      </ToolButton>
      <ToolButton
        label="Italique"
        active={editor.isActive('italic')}
        onClick={() => chain().toggleItalic().run()}
      >
        <Italic className="size-4" />
      </ToolButton>
      <ToolButton
        label="Souligné"
        active={editor.isActive('underline')}
        onClick={() => chain().toggleUnderline().run()}
      >
        <Underline className="size-4" />
      </ToolButton>
      <ToolButton
        label="Titre"
        active={editor.isActive('heading', { level: 2 })}
        onClick={() => chain().toggleHeading({ level: 2 }).run()}
      >
        <Heading2 className="size-4" />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      <ToolButton
        label="Liste à puces"
        active={editor.isActive('bulletList')}
        onClick={() => chain().toggleBulletList().run()}
      >
        <List className="size-4" />
      </ToolButton>
      <ToolButton
        label="Liste numérotée"
        active={editor.isActive('orderedList')}
        onClick={() => chain().toggleOrderedList().run()}
      >
        <ListOrdered className="size-4" />
      </ToolButton>
      <ToolButton
        label="Aligner à gauche"
        active={editor.isActive({ textAlign: 'left' })}
        onClick={() => chain().setTextAlign('left').run()}
      >
        <AlignLeft className="size-4" />
      </ToolButton>
      <ToolButton
        label="Aligner à droite"
        active={editor.isActive({ textAlign: 'right' })}
        onClick={() => chain().setTextAlign('right').run()}
      >
        <AlignRight className="size-4" />
      </ToolButton>
      <ToolButton
        label="Centrer"
        active={editor.isActive({ textAlign: 'center' })}
        onClick={() => chain().setTextAlign('center').run()}
      >
        <AlignCenter className="size-4" />
      </ToolButton>
      <span className="mx-1 h-5 w-px bg-border" aria-hidden />
      {onLink ? (
        <ToolButton label="Lien" active={editor.isActive('link')} onClick={onLink}>
          <Link2 className="size-4" />
        </ToolButton>
      ) : null}
      {onImage ? (
        <ToolButton label="Insérer une image" onClick={onImage}>
          <ImagePlus className="size-4" />
        </ToolButton>
      ) : null}
      <label className="ml-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
        <span className="sr-only">Couleur du texte</span>
        <input
          ref={colorRef}
          type="color"
          aria-label="Couleur du texte"
          title="Couleur du texte"
          className="size-6 cursor-pointer rounded border bg-transparent p-0"
          defaultValue="#1c2b22"
          onChange={(e) => chain().setColor(e.target.value).run()}
        />
      </label>
    </>
  );
}
