import { X } from 'lucide-react'
import './EnterpriseUI.css'

export const PageHeader = ({ eyebrow, title, description, actions, children, className = '' }) => (
  <header className={`hf-page-header ${className}`.trim()}>
    <div className="hf-page-header__content">
      {eyebrow && <span className="hf-page-header__eyebrow">{eyebrow}</span>}
      {title && <h1 className="hf-page-header__title">{title}</h1>}
      {description && <p className="hf-page-header__description">{description}</p>}
      {children}
    </div>
    {actions && <div className="hf-page-header__actions">{actions}</div>}
  </header>
)

export const Toolbar = ({ title, description, children, actions, className = '' }) => (
  <section className={`hf-toolbar ${className}`.trim()}>
    <div className="hf-toolbar__main">
      {(title || description) && (
        <div>
          {title && <h2 className="hf-toolbar__title">{title}</h2>}
          {description && <p className="hf-toolbar__description">{description}</p>}
        </div>
      )}
      {children}
    </div>
    {actions && <div className="hf-toolbar__actions">{actions}</div>}
  </section>
)

export const StatCard = ({ label, value, meta, children, className = '' }) => (
  <article className={`hf-stat-card ${className}`.trim()}>
    {label && <span className="hf-stat-card__label">{label}</span>}
    {value !== undefined && value !== null && <strong className="hf-stat-card__value">{value}</strong>}
    {meta && <p className="hf-stat-card__meta">{meta}</p>}
    {children}
  </article>
)

export const EmptyState = ({ icon, title = 'No records found', description, actions, className = '' }) => (
  <div className={`hf-empty-state ${className}`.trim()}>
    {icon && <div className="hf-empty-state__icon" aria-hidden="true">{icon}</div>}
    <h3>{title}</h3>
    {description && <p>{description}</p>}
    {actions}
  </div>
)

export const LoadingState = ({ title = 'Loading', description = 'Preparing data...', className = '' }) => (
  <div className={`hf-loading-state ${className}`.trim()} role="status" aria-live="polite">
    <div className="hf-loading-state__spinner" aria-hidden="true" />
    <h3>{title}</h3>
    {description && <p>{description}</p>}
  </div>
)

export const StatusBadge = ({ tone = 'neutral', children, className = '' }) => (
  <span className={`hf-status-badge hf-status-badge--${tone} ${className}`.trim()}>
    {children}
  </span>
)

export const IconButton = ({
  label,
  title,
  children,
  type = 'button',
  className = '',
  ...props
}) => (
  <button
    type={type}
    className={`hf-icon-button ${className}`.trim()}
    aria-label={label}
    title={title || label}
    {...props}
  >
    {children}
  </button>
)

export const FormSection = ({ title, description, children, actions, className = '' }) => (
  <section className={`hf-form-section ${className}`.trim()}>
    {(title || description || actions) && (
      <div className="hf-form-section__header">
        {title && <h2 className="hf-form-section__title">{title}</h2>}
        {description && <p className="hf-form-section__description">{description}</p>}
        {actions}
      </div>
    )}
    <div className="hf-form-section__content">{children}</div>
  </section>
)

export const ModalShell = ({
  open,
  title,
  children,
  footer,
  onClose,
  size = 'md',
  labelledBy,
  className = '',
}) => {
  if (!open) return null

  const titleId = labelledBy || (title ? `hf-modal-${String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : undefined)

  return (
    <div className="hf-modal-overlay" role="presentation">
      <section
        className={`hf-modal-shell hf-modal-shell--${size} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="hf-modal-shell__header">
          {title && <h2 className="hf-modal-shell__title" id={titleId}>{title}</h2>}
          {onClose && (
            <IconButton label="Close dialog" onClick={onClose}>
              <X size={18} />
            </IconButton>
          )}
        </header>
        <div className="hf-modal-shell__body">{children}</div>
        {footer && <footer className="hf-modal-shell__footer">{footer}</footer>}
      </section>
    </div>
  )
}

const getColumnKey = (column, index) => column.key || column.accessor || column.header || index

const getCellValue = (row, column) => {
  if (typeof column.render === 'function') return column.render(row)
  if (typeof column.accessor === 'function') return column.accessor(row)
  if (column.accessor) return row?.[column.accessor]
  if (column.key) return row?.[column.key]
  return ''
}

export const DataTable = ({
  columns = [],
  rows = [],
  getRowKey,
  loading = false,
  loadingState,
  emptyState,
  minWidth,
  className = '',
}) => {
  if (loading) {
    return (
      <div className={`hf-table-shell ${className}`.trim()}>
        {loadingState || <LoadingState title="Loading records" description="Fetching the latest data..." />}
      </div>
    )
  }

  if (!rows.length) {
    return (
      <div className={`hf-table-shell ${className}`.trim()}>
        {emptyState || <EmptyState />}
      </div>
    )
  }

  return (
    <div className={`hf-table-shell ${className}`.trim()}>
      <div className="hf-table-scroll">
        <table className="hf-data-table" style={minWidth ? { minWidth } : undefined}>
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th key={getColumnKey(column, index)} scope="col">
                  {column.header || column.label || column.key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={getRowKey ? getRowKey(row, rowIndex) : row.id || rowIndex}>
                {columns.map((column, columnIndex) => (
                  <td key={getColumnKey(column, columnIndex)}>
                    {getCellValue(row, column)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
