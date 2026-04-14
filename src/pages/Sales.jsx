import { useState } from 'react'
import { Search, Trash2, Plus, Minus, ShoppingCart } from 'lucide-react'
import './Sales.css'

const Sales = () => {
  const [cart, setCart] = useState([
    { id: 1, name: 'Ibuprofen 200mg', price: 4.00, quantity: 3 },
    { id: 2, name: 'Ibuprofen 200mg', price: 4.00, quantity: 2 },
    { id: 3, name: 'Vitamin C 1000mg', price: 15.00, quantity: 1 }
  ])
  const [paymentMethod, setPaymentMethod] = useState('cash')
  const [received, setReceived] = useState('25.27')

  const calculateTotal = () => {
    return cart.reduce((sum, item) => sum + (item.price * item.quantity), 0)
  }

  const calculateChange = () => {
    const total = calculateTotal()
    const receivedAmount = parseFloat(received) || 0
    return Math.max(0, receivedAmount - total)
  }

  const updateQuantity = (id, change) => {
    setCart(cart.map(item => 
      item.id === id 
        ? { ...item, quantity: Math.max(1, item.quantity + change) }
        : item
    ))
  }

  const removeItem = (id) => {
    setCart(cart.filter(item => item.id !== id))
  }

  const total = calculateTotal()
  const change = calculateChange()

  return (
    <div className="sales-page">
      <div className="page-header">
        <h1>Sales (POS)</h1>
        <p>Quick drug dispensing and checkout</p>
      </div>

      <div className="pos-layout">
        {/* Left Side - Product Selection */}
        <div className="product-section">
          <div className="search-drug">
            <Search size={20} />
            <input 
              type="text" 
              placeholder="Search drug or scan barcode..." 
            />
          </div>

          <div className="quick-add">
            <h3>Or Quick Add</h3>
            <div className="drug-grid">
              {[
                { name: 'Paracetamol', price: 5 },
                { name: 'Ibuprofen', price: 4 },
                { name: 'Amoxicillin', price: 37 },
                { name: 'Vitamin C', price: 15 }
              ].map((drug, index) => (
                <button key={index} className="drug-card">
                  <span className="drug-name">{drug.name}</span>
                  <span className="drug-price">GHS {drug.price}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Right Side - Cart & Checkout */}
        <div className="checkout-section">
          <div className="cart-header">
            <h3>Selected Items</h3>
            <span className="item-count">{cart.length} items</span>
          </div>

          <div className="cart-items">
            {cart.length === 0 ? (
              <div className="empty-cart">
                <ShoppingCart size={48} />
                <p>No items in cart</p>
                <span>Search or select drugs to add</span>
              </div>
            ) : (
              cart.map((item) => (
                <div key={item.id} className="cart-item">
                  <div className="item-info">
                    <span className="item-name">{item.name}</span>
                    <span className="item-price">GHS {item.price.toFixed(2)}</span>
                  </div>
                  <div className="item-controls">
                    <div className="quantity-controls">
                      <button onClick={() => updateQuantity(item.id, -1)}>
                        <Minus size={14} />
                      </button>
                      <span className="quantity">{item.quantity}</span>
                      <button onClick={() => updateQuantity(item.id, 1)}>
                        <Plus size={14} />
                      </button>
                    </div>
                    <span className="item-total">
                      GHS {(item.price * item.quantity).toFixed(2)}
                    </span>
                    <button 
                      className="remove-btn"
                      onClick={() => removeItem(item.id)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="checkout-summary">
            <div className="total-section">
              <span className="total-label">Total</span>
              <span className="total-amount">GHS {total.toFixed(2)}</span>
            </div>

            <div className="payment-methods">
              <button 
                className={`payment-btn ${paymentMethod === 'cash' ? 'active' : ''}`}
                onClick={() => setPaymentMethod('cash')}
              >
                Cash
              </button>
              <button 
                className={`payment-btn ${paymentMethod === 'momo' ? 'active' : ''}`}
                onClick={() => setPaymentMethod('momo')}
              >
                Mobile Money
              </button>
              <button 
                className={`payment-btn ${paymentMethod === 'insurance' ? 'active' : ''}`}
                onClick={() => setPaymentMethod('insurance')}
              >
                Insurance
              </button>
            </div>

            {paymentMethod === 'cash' && (
              <div className="cash-inputs">
                <div className="input-group">
                  <label>Received (GHS)</label>
                  <div className="input-wrapper">
                    <input 
                      type="number" 
                      value={received}
                      onChange={(e) => setReceived(e.target.value)}
                      step="0.01"
                    />
                  </div>
                </div>
                <div className="change-display">
                  <span>Change</span>
                  <span className="change-amount">GHS {change.toFixed(2)}</span>
                </div>
              </div>
            )}

            <button 
              className="complete-sale-btn"
              disabled={cart.length === 0}
            >
              Complete Sale
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default Sales
