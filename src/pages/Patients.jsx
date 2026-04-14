import { useState } from 'react'
import { Plus, Search, Phone, Mail } from 'lucide-react'
import './Patients.css'

const Patients = () => {
  const [patients] = useState([
    {
      id: 1,
      name: 'Kwame Boateng',
      phone: '+233 24 765 4321',
      email: 'kwame.b@email.com',
      lastVisit: '2026-04-03',
      visits: 12
    },
    {
      id: 2,
      name: 'Ama Mensah',
      phone: '+233 20 123 4567',
      email: 'ama.m@email.com',
      lastVisit: '2026-04-02',
      visits: 8
    },
    {
      id: 3,
      name: 'Michael Asante',
      phone: '+233 55 987 6543',
      email: 'michael.a@email.com',
      lastVisit: '2026-03-28',
      visits: 5
    }
  ])

  return (
    <div className="patients-page">
      <div className="page-header">
        <div>
          <h1>Patient Records</h1>
          <p>Manage patient information and prescription history</p>
        </div>
        <button className="btn btn-primary">
          <Plus size={20} />
          Add Patient
        </button>
      </div>

      <div className="search-container">
        <Search size={18} />
        <input type="text" placeholder="Search patients by name, phone, or email..." />
      </div>

      <div className="patients-grid">
        {patients.map((patient) => (
          <div key={patient.id} className="patient-card">
            <div className="patient-avatar">
              {patient.name.split(' ').map(n => n[0]).join('')}
            </div>
            <div className="patient-info">
              <h3>{patient.name}</h3>
              <div className="contact-info">
                <span>
                  <Phone size={14} />
                  {patient.phone}
                </span>
                <span>
                  <Mail size={14} />
                  {patient.email}
                </span>
              </div>
            </div>
            <div className="patient-stats">
              <div className="stat">
                <span className="stat-label">Last Visit</span>
                <span className="stat-value">{new Date(patient.lastVisit).toLocaleDateString()}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Total Visits</span>
                <span className="stat-value">{patient.visits}</span>
              </div>
            </div>
            <button className="btn btn-outline">View History</button>
          </div>
        ))}
      </div>
    </div>
  )
}

export default Patients
